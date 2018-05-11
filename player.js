var Game = require('./game.js');
var deepcopy = require('deepcopy');

var id_incr = 0;
var player_dict = {};
var queued = [];

function Player(ws) {
    this.state = 'init';
    this.ws = ws;
    this.id = id_incr;
    player_dict[this.id] = this;
    id_incr++;
}

Player.get = function(playerId) {
    return player_dict[playerId];
};

Player.prototype.getId = function() {
    return this.id;
};

Player.prototype.authenticate = function(username) {
    this.username = username;
    return true;
};

Player.prototype.sendPacket = function(type, data) {
    // send if socket is open
    if (this.ws.readyState == 1) {
        this.ws.send(JSON.stringify({ type: type, data: data }));
    }
};
var constants = require('./public/js/constants.js');

Player.prototype.setGameState = function(gameState) {
    this.state = gameState;
    this.sendPacket('gameState', gameState);
}

/*
 * Handle a forced disconnect or the case when a client disconnects.
 */
Player.prototype.disconnect = function(errorMessage) {
    if (errorMessage) {
        this.sendPacket('error', errorMessage);
    }
    var i = queued.indexOf(this.id);
    if (i > -1) {
        queued.splice(i, 1);
    }
    if (this.game) {
        this.game.end(this.game.getOpponent(this));
    }
    this.ws.close();
}

/*
 * Returns the current player deck for the game, with the cards in randomized order.
 */
Player.prototype.getDeck = function() {
    var cardIds = this.getCards();
    Array.prototype.push.apply(cardIds, cardIds);
    return cardIds.sort(() => 0.5 - Math.random()).slice(0, 30);
}

Player.prototype.getCards = function() {
    var cardIds = Object.keys(constants.cards).map((k) => parseInt(k)).filter((k) => constants.cards[k].obtainable !== false);
    return cardIds;
};

/**
 * Transfer a card from the player's deck to their hand.
 */
Player.prototype.drawCard = function() {
    if (this.deck.length > 0) {
        var newCard = this.deck.pop();
        if (this.hand.length < constants.player.MAX_CARDS) {
            this.hand.push(parseInt(newCard));
            this.sendPacket("addCard", { player: this.id, card: newCard });
            this.game.getOpponent(this).sendPacket("addCard", { player: this.id });
        }
        else {
            this.sendPacket("discardCard", { playerId: this.id, cardId: newCard });
        }
    }
};

Player.prototype.spawnMinion = function (minionId) {
    var minionInfo = constants.minions[minionId];
    if (this.minions.length >= constants.player.MAX_MINIONS) {
        return false;
    }
    var copy = deepcopy(minionInfo);
    copy._health = copy.health;
    copy._attack = copy.attack;
    const plr = this;
    copy.hasAttribute = function(attr) {
        if (!copy.attributes) {
            return false;
        }
        return copy.attributes.indexOf(attr) > -1;
    };
    copy.addAttribute = function(attr) {
        if (!this.attributes) {
            this.attributes = [];
        }
        this.attributes.push(attr);
        plr.game.sendPacket("updateMinion", {
            playerId: plr.id,
            minionInstanceId: this.minionInstanceId,
            attributes: this.attributes
        });
    };
    copy.hasAttack = copy.hasAttribute('charge');
    delete copy.health;
    delete copy.attack;
    Object.defineProperty(copy, 'attack', {
        get: function() {
            return this._attack;
        },
        set: function(amount) {
            this._attack = amount;
            plr.game.sendPacket("updateMinion", {
                playerId: plr.id,
                minionInstanceId: this.minionInstanceId,
                attack: this.attack
            });
        }
    });
    Object.defineProperty(copy, 'health', {
        get: function() {
            return this._health;
        },
        set: function(amount) {
            // if already dead, don't do further processing
            if (this._health < 0) {
                return;
            }

            var doingDamage = false;
            if (this._health > amount) {
                doingDamage = true;
            }

            // check if minion has shield
            if (doingDamage && this.hasAttribute('shield')) {
                this.attributes.splice(this.attributes.indexOf('shield'), 1);
            }
            else {
                this._health = amount;
            }

            if (doingDamage) {
                // process minion_damage event
                function process(minion, plr) {
                    var actions = plr.processActions(minion.events.minion_damage, minion.minionInstanceId);
                    if (actions !== false) {
                        actions.forEach((x) => x());
                    }
                    else {
                        console.warn('Failed when processing minion events, this should not happen!');
                    }
                }
                plr.minions.filter((x) => x.events && x.events.minion_damage).forEach((x) => process(x, plr));
                var opp = plr.game.getOpponent(plr);
                opp.minions.filter((x) => x.events && x.events.minion_damage).forEach((x) => process(x, opp));
            }
            if (this.health <= 0) {
                // process deathrattle events
                if (this.hasAttribute('deathrattle')) {
                    plr.processActions(this.deathrattle).forEach((x) => x());
                }
                plr.minions.splice(plr.minions.indexOf(copy), 1);
                plr.game.sendPacket("removeMinion", {
                    playerId: plr.id,
                    minionInstanceId: copy.minionInstanceId
                });
            }
            else {
                plr.game.sendPacket("updateMinion", {
                    playerId: plr.id,
                    minionInstanceId: this.minionInstanceId,
                    health: this.health,
                    attributes: this.attributes
                });
            }
        }
    });
    copy.minionInstanceId = this.game.minionIdCounter;
    this.game.minionIdCounter++;
    this.minions.push(copy);
    this.game.sendPacket("addMinion", {
        playerId: this.id,
        minionInstanceId: copy.minionInstanceId,
        minionId: minionInfo.id,
        hasAttack: copy.hasAttack
    });
    return true;
};

Player.prototype.damage = function(amount) {
    this.health -= amount;
    if (this.health <= 0) {
        this.game.end(this.game.getOpponent(this));
    }
    this.game.sendPacket("updatePlayer", { playerId: this.id, health: this.health });
};

Player.prototype.sendError = function(errorMsg) {
    this.sendPacket("error", errorMsg);
};

Player.prototype.doAttack = function(from, to) {
    var fromMinion = this.minions.find((x) => x.minionInstanceId == from);

    if (!fromMinion) {
        this.sendError('No minion found to perform attack!');
        return false;
    }

    var hasTaunt = this.game.getOpponent(this).minions.filter((x) => x.hasAttribute('taunt')).length > 0;

    // check if minion has attack
    if (!fromMinion.hasAttack) {
        return;
    }

    if (to == "opponent") {
        if (!hasTaunt) {
            this.game.getOpponent(this).damage(fromMinion.attack);
        }
        else {
            this.sendError("You must attack a minion with taunt!");
            return false;
        }
    }
    else {
        var toMinion = this.game.getOpponent(this).minions.find((x) => x.minionInstanceId == to);
        if (toMinion) {
            if (hasTaunt && !toMinion.hasAttribute('taunt')) {
                this.sendError("You must attack a minion with taunt!");
                return false;
            }
            toMinion.health -= fromMinion.attack;
            fromMinion.health -= toMinion.attack;
        }
        else {
            this.sendError("Cannot attack that object!");
            return false;
        }
    }
    fromMinion.hasAttack = false;
    this.game.sendPacket("updateMinion", {
        playerId: this.id,
        minionInstanceId: fromMinion.minionInstanceId,
        hasAttack: fromMinion.hasAttack
    });
};

Player.prototype.processActions = function(rawActions, target) {
    const game = this.game;
    const plr = this;
    const opp = game.getOpponent(plr);
    var playCard = true;
    var actions = [];
    if (rawActions) {
        rawActions.forEach(function(action) {
            if (Array.isArray(action)) {
                switch (action[0]) {
                    case 'draw':
                        actions.push(function() {
                            for (var i = 0; i < action[1]; i++) {
                                plr.drawCard();
                            }
                        });
                        break;
                    case 'damage':
                        actions.push(function() {
                            if (target == "opponent") {
                                opp.damage(action[1]);
                            }
                            else if (target == "player") {
                                plr.damage(action[1]);
                            }
                            else {
                                var toMinion = game.findMinion(target);
                                toMinion.health -= action[1];
                            }
                        });
                        break;
                    case 'attribute':
                        var toMinion = game.findMinion(target);
                        if (typeof toMinion === 'undefined') {
                            playCard = false;
                        }
                        else if (toMinion.hasAttribute(action[1])) {
                            playCard = false;
                        }
                        actions.push(function() {
                            toMinion.addAttribute(action[1]);
                        });
                        break;
                    case 'all_damage':
                        actions.push(function() {
                            plr.damage(action[1]);
                            opp.damage(action[1]);
                            plr.minions.slice().forEach((x) => x.health -= action[1]);
                            opp.minions.slice().forEach((x) => x.health -= action[1]);
                        });
                        break;
                    case 'random_damage':
                        actions.push(function() {
                            var all = plr.minions.concat(opp.minions).concat([plr, opp]);
                            var random = all[Math.floor(all.length * Math.random())];
                            if (random instanceof Player) {
                                random.damage(action[1]);
                            }
                            else {
                                random.health -= action[1];
                            }
                        });
                        break;
                    case 'mana':
                        actions.push(function() {
                            plr.mana += action[1];
                            game.sendPacket("updatePlayer", { playerId: plr.id, mana: plr.mana });
                        });
                        break;
                    case 'buff_attack':
                        var toMinion = game.findMinion(target);
                        if (typeof toMinion === 'undefined') {
                            playCard = false;
                        }
                        actions.push(function() {
                            toMinion.attack += action[1];
                        });
                        break;
                    case 'buff_attack_all':
                        actions.push(function() {
                            for (var i = plr.minions.length - 1; i >= 0; i--) {
                                plr.minions[i].attack += action[1];
                            }
                        });
                        break;
                    case 'buff_health':
                        var toMinion = game.findMinion(target);
                        if (typeof toMinion === 'undefined') {
                            playCard = false;
                        }
                        actions.push(function() {
                            toMinion.health += action[1];
                        });
                        break;
                    case 'buff_health_all':
                        actions.push(function() {
                            for (var i = plr.minions.length - 1; i >= 0; i--) {
                                plr.minions[i].health += action[1];
                            }
                        });
                        break;
                    case 'discard':
                        actions.push(function() {
                            for (var i = 0; i < action[1]; i++) {
                                if (plr.hand.length > 0) {
                                    var random = Math.floor(plr.hand.length * Math.random());
                                    var cardId = plr.hand.splice(random, 1)[0];
                                    game.sendPacket("discardCard", {
                                        playerId: plr.id,
                                        cardId: cardId
                                    });
                                }
                            }
                        });
                        break;
                    case 'damage_opponent':
                        actions.push(function() {
                            opp.damage(action[1]);
                        });
                        break;
                    case 'damage_player':
                        actions.push(function() {
                            plr.damage(action[1]);
                        });
                        break;
                    case 'spawn':
                        actions.push(function() {
                            action[1].forEach(function(minionId) {
                                plr.spawnMinion(minionId);
                            });
                        });
                        break;
                    default:
                        console.warn('Unknown spell card action: ' + action[0]);
                        break;
                }
            }
        });
    }
    if (playCard) {
        return actions;
    }
    return false;
}

Player.prototype.playCard = function(cardId, target) {
    if (this.game) {
        var cardInfo = constants.cards[cardId];
        var cardIndex = this.hand.indexOf(parseInt(cardId));
        if (this.game.turn != this.id) {
            this.sendError("It is not currently your turn!");
            return false;
        }
        if (cardInfo.mana > this.mana) {
            this.sendError("You do not have enough mana to play this card!");
            return false;
        }
        if (cardInfo.target && typeof target !== 'number' && typeof target !== 'string') {
            this.sendError("This card requires a target to be played on!");
            return false;
        }
        if (cardIndex <= -1) {
            console.warn('Player tried playing nonexistent card: ' + cardId + ' (' + cardInfo.name + ', index: ' + cardIndex + '), only has ' + this.hand);
            this.sendError("You do not have this card!");
            return false;
        }
        var plr = this;
        var game = this.game;
        var opp = game.getOpponent(plr);
        var actions = plr.processActions(cardInfo.actions, target);
        if (actions === false) {
            this.sendError("Cannot play this card in this situation!");
            return false;
        }
        switch (cardInfo.type) {
            case 'minion':
                if (plr.minions.length > constants.player.MAX_MINIONS) {
                    this.sendError("Cannot play this card, board is full!");
                    return false;
                }
                actions.push(function() {
                    cardInfo.spawn.forEach(function(minionId) {
                        plr.spawnMinion(minionId);
                    });
                });
                break;
            case 'spell':
                break;
            default:
                console.warn('Unknown card type: ' + cardInfo.type);
                break;
        }
        this.hand.splice(cardIndex, 1);
        actions.forEach((x) => x());
        this.mana -= cardInfo.mana;
        this.game.sendPacket("playCard", {
            playerMana: this.mana,
            playerId: this.id,
            cardId: cardId
        });
        return true;
    }
    else {
        throw "Tried to play card while not in game!";
    }
};

/*
 * Add a player to the queue of players searching for a game or start a new game with 2 players.
 */
Player.prototype.addToQueue = function() {
    if (queued.length > 0) {
        var opponent = queued.pop();
        var game = new Game(this, Player.get(opponent));
        game.init();
    }
    else {
        queued.push(this.id);
    }
};

module.exports = Player;
