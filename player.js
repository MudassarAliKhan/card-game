var Game = require('./game.js');
var deepcopy = require('deepcopy');

var id_incr = 0;
var player_dict = {};
var queued = [];

function Player(ws) {
    this.state = 'init';
    this.ws = ws;
    this.id = id_incr;
    this.isMinion = false;
    this.isPlayer = true;
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
    if (username.length > 0) {
        this.username = username;
        return true;
    }
    else {
        return false;
    }
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
};

/*
 * Handle a forced disconnect or the case when a client disconnects.
 */
Player.prototype.disconnect = function(errorMessage) {
    if (errorMessage) {
        this.sendPacket('error', errorMessage);
    }
    this.removeFromQueue();
    const game = this.game;
    if (game) {
        game.end(game.getOpponent(this));
    }
    if (this.ws) {
        this.ws.close();
    }
};

/*
 * Returns the current player deck for the game, with the cards in randomized order.
 */
Player.prototype.getDeck = function() {
    var cardIds = this.getCards();
    Array.prototype.push.apply(cardIds, cardIds);
    return cardIds.sort(() => 0.5 - Math.random()).slice(0, constants.player.DECK_SIZE);
};

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
        this.addCard(newCard);
    }
};

Player.prototype.addCard = function(newCard) {
    const game = this.game;
    if (!game) {
        return false;
    }
    if (this.hand.length < constants.player.MAX_CARDS) {
        this.hand.push(parseInt(newCard));
        this.sendPacket("addCard", { player: this.id, card: newCard, cardsLeft: this.deck.length });
        game.getOpponent(this).sendPacket("addCard", { player: this.id, cardsLeft: this.deck.length });
    }
    else {
        this.sendPacket("discardCard", { playerId: this.id, cardId: newCard });
    }
    return true;
};

Player.prototype.doMulligan = function(redos) {
    if (this.game.turn != -1) {
        this.sendError('You cannot mulligan after the beginning phase!');
        return false;
    }
    if (this.playerMulliganDone) {
        this.sendError('You can only mulligan once!');
        return false;
    }

    for (var i = 0; i < this.hand.length; i++) {
        if (redos[i]) {
            var deckPos = Math.floor(Math.random() * this.deck.length);
            var temp = this.deck[deckPos];
            this.deck[deckPos] = this.hand[i];
            this.hand[i] = temp;
            this.sendPacket('addCard', {
                player: this.id,
                card: this.hand[i],
                cardsLeft: this.deck.length
            });
            this.sendPacket('discardCard', {
                playerId: this.id,
                cardId: this.deck[deckPos]
            });
        }
    }

    // if both players done with choosing cards, start the game
    if (this.game.playerMulliganDone) {
        this.game.initTurn();
    }
    else {
        this.game.playerMulliganDone = true;
        this.playerMulliganDone = true;
    }
    return true;
};

Player.prototype.spawnMinion = function (minionId, cardId, position) {
    var minionInfo = constants.minions[minionId];
    if (this.minions.length >= constants.player.MAX_MINIONS) {
        return false;
    }
    var copy = deepcopy(minionInfo);
    copy.cardId = cardId;
    copy.isPlayer = false;
    copy.isMinion = true;
    copy._health = copy.health;
    copy._maxHealth = copy.health;
    copy._attack = copy.attack;
    const plr = this;
    const opp = plr.game.getOpponent(plr);
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
    copy.removeAllAttributes = function() {
        this.attributes = [];
        this.events = {};
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
            if (this._attack < 0) {
                this._attack = 0;
            }
            plr.game.sendPacket("updateMinion", {
                playerId: plr.id,
                minionInstanceId: this.minionInstanceId,
                attack: this.attack
            });
        }
    });
    Object.defineProperty(copy, 'maxHealth', {
        get: function() { return this._maxHealth; },
        set: function(amount) { this._maxHealth = amount; }
    });

    copy.destroy = function(fromAttack, doEvents) {
        plr.minions.splice(plr.minions.indexOf(copy), 1);
        plr.game.sendPacket("removeMinion", {
            playerId: plr.id,
            minionInstanceId: copy.minionInstanceId,
            health: this.health,
            attackFrom: fromAttack
        });
        // process death events
        if (doEvents) {
            if (this.events && this.events.death) {
                plr.processActions(this.events.death).forEach((x) => x());
            }
            plr.minions.forEach(function(minion) {
                if (minion.events && minion.events.friendly_death) {
                    plr.processActions(minion.events.friendly_death).forEach((x) => x());
                }
            });
            opp.minions.forEach(function(minion) {
                if (minion.events && minion.events.opponent_death) {
                    opp.processActions(minion.events.opponent_death).forEach((x) => x());
                }
            });
        }
    };

    copy.setHealth = function(amount, fromAttack) {
        // if game ended, don't do anything
        const game = plr.game;
        if (!game || game.ended) {
            return;
        }
        // if already dead, don't do further processing
        if (this._health <= 0) {
            return;
        }
        if (amount > this._maxHealth) {
            amount = this._maxHealth;
        }

        var doingDamage = false;
        if (this._health > amount) {
            doingDamage = true;
        }

        // check if minion has shield
        if (doingDamage && this.hasAttribute('shield')) {
            this.attributes.splice(this.attributes.indexOf('shield'), 1);
            doingDamage = false;
        }
        else {
            this._health = amount;
        }

        if (doingDamage) {
            // process minion_damage event
            var process = function(minion, plr) {
                var actions = plr.processActions(minion.events.minion_damage, minion.minionInstanceId);
                if (actions !== false) {
                    actions.forEach((x) => x());
                }
                else {
                    throw new Error('Failed when processing minion events, this should not happen!');
                }
            };
            plr.minions.filter((x) => x.events && x.events.minion_damage).forEach((x) => process(x, plr));
            opp.minions.filter((x) => x.events && x.events.minion_damage).forEach((x) => process(x, opp));
        }
        if (this.health <= 0) {
            this.destroy(fromAttack, true);
        }
        else {
            if (doingDamage) {
                if (this.events && this.events.self_damage) {
                    plr.processActions(this.events.self_damage, this.minionInstanceId).forEach((x) => x());
                }
            }
            game.sendPacket("updateMinion", {
                playerId: plr.id,
                minionInstanceId: this.minionInstanceId,
                health: this.health,
                attributes: this.attributes,
                attackFrom: fromAttack
            });
        }
    };

    Object.defineProperty(copy, 'health', {
        get: function() {
            return this._health;
        },
        set: copy.setHealth
    });
    copy.minionInstanceId = this.game.minionIdCounter;
    this.game.minionIdCounter++;

    // process minion_spawn event
    function process(minion, plr) {
        var actions = plr.processActions(minion.events.minion_spawn, minion.minionInstanceId);
        if (actions !== false) {
            actions.forEach((x) => x());
        }
        else {
            throw new Error('Failed when processing minion events, this should not happen!');
        }
    }
    plr.minions.filter((x) => x.events && x.events.minion_spawn).forEach((x) => process(x, plr));
    opp.minions.filter((x) => x.events && x.events.minion_spawn).forEach((x) => process(x, opp));

    this.minions.splice(position, 0, copy);
    this.game.sendPacket("addMinion", {
        playerId: this.id,
        minionInstanceId: copy.minionInstanceId,
        minionId: minionInfo.id,
        hasAttack: copy.hasAttack,
        cardId: cardId,
        position: position
    });
    return true;
};

Player.prototype.damage = function(amount, source) {
    this.health -= amount;
    if (this.health > constants.player.MAX_HEALTH) {
        this.health = constants.player.MAX_HEALTH;
    }
    const game = this.game;
    if (game) {
        game.sendPacket("updatePlayer", { playerId: this.id, health: this.health, attackFrom: source });
        if (this.health <= 0) {
            game.end(game.getOpponent(this));
        }
    }
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

    const game = this.game;
    if (!game) {
        return false;
    }

    var hasTaunt = game.getOpponent(this).minions.filter((x) => x.hasAttribute('taunt')).length > 0;

    // check if minion has attack
    if (!fromMinion.hasAttack) {
        this.sendError("This minion does not have an attack!");
        return;
    }

    if (to == "opponent") {
        if (!hasTaunt) {
            this.game.getOpponent(this).damage(fromMinion.attack, fromMinion.minionInstanceId);
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
            toMinion.setHealth(toMinion.health - fromMinion.attack, fromMinion.minionInstanceId);
            fromMinion.health -= toMinion.attack;
        }
        else {
            this.sendError("Cannot attack that object!");
            return false;
        }
    }
    fromMinion.hasAttack = false;
    game.sendPacket("updateMinion", {
        minionInstanceId: fromMinion.minionInstanceId,
        hasAttack: fromMinion.hasAttack
    });
};

Player.prototype.processActions = function(rawActions, target, cardId, position) {
    const game = this.game;
    const plr = this;
    const opp = game.getOpponent(plr);
    var playCard = true;
    var actions = [];
    var targetObject = null;
    if (target == "opponent") {
        targetObject = opp;
    }
    else if (target == "player") {
        targetObject = plr;
    }
    else if (typeof target !== 'undefined') {
        targetObject = game.findMinion(target);
    }
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
                    case 'heal':
                        action[1] = -action[1];
                        if (!targetObject) {
                            playCard = false;
                        }
                        else {
                            actions.push(function() {
                                if (targetObject.isPlayer) {
                                    targetObject.damage(action[1]);
                                }
                                else {
                                    targetObject.health -= action[1];
                                }
                            });
                        }
                        break;
                    case 'damage':
                        if (!targetObject) {
                            playCard = false;
                        }
                        else {
                            actions.push(function() {
                                if (targetObject.isPlayer) {
                                    targetObject.damage(action[1]);
                                }
                                else {
                                    targetObject.health -= action[1];
                                }
                            });
                        }
                        break;
                    case 'replace':
                        var toMinionReplace = game.findMinion(target);
                        if (typeof toMinionReplace === 'undefined') {
                            playCard = false;
                        }
                        actions.push(function() {
                            var minionIndex = game.p1.minions.indexOf(toMinionReplace);
                            var minionPlr = game.p1;
                            if (minionIndex <= -1) {
                                minionIndex = game.p2.minions.indexOf(toMinionReplace);
                                minionPlr = game.p2;
                            }
                            if (minionIndex <= -1) {
                                throw new Error('Could not find minion to replace!');
                            }
                            toMinionReplace.destroy(null, false);
                            if (!minionPlr.spawnMinion(action[1], cardId, minionIndex)) {
                                throw new Error('Could not spawn replacement minion!');
                            }
                        });
                        break;
                    case 'destroy':
                        if (!targetObject || !targetObject.isMinion) {
                            playCard = false;
                        }
                        else {
                            actions.push(function() {
                                targetObject.destroy(null, true);
                            });
                        }
                        break;
                    case 'attribute':
                        if (!targetObject || !targetObject.isMinion) {
                            playCard = false;
                        }
                        else if (targetObject.hasAttribute(action[1])) {
                            playCard = false;
                        }
                        actions.push(function() {
                            targetObject.addAttribute(action[1]);
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
                    case 'all_damage_opponent':
                        actions.push(function() {
                            opp.damage(action[1]);
                            opp.minions.slice().forEach((x) => x.health -= action[1]);
                        });
                        break;
                    case 'random_damage':
                        actions.push(function() {
                            var all = plr.minions.concat(opp.minions).concat([plr, opp]);
                            var random = all[Math.floor(all.length * Math.random())];
                            if (random instanceof Player) {
                                random.damage(action[1], target);
                            }
                            else {
                                random.setHealth(random.health - action[1], target);
                            }
                        });
                        break;
                    case 'random_damage_opponent':
                        actions.push(function() {
                            var all = opp.minions.concat([opp]);
                            var random = all[Math.floor(all.length * Math.random())];
                            if (random instanceof Player) {
                                random.damage(action[1], target);
                            }
                            else {
                                random.setHealth(random.health - action[1], target);
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
                        var toMinionAttackBuff = game.findMinion(target);
                        if (typeof toMinionAttackBuff === 'undefined') {
                            playCard = false;
                        }
                        actions.push(function() {
                            toMinionAttackBuff.attack += action[1];
                        });
                        break;
                    case 'buff_attack_all':
                        actions.push(function() {
                            plr.minions.slice().forEach((x) => x.attack += action[1]);
                        });
                        break;
                    case 'buff_health':
                        var toMinionHealthBuff = game.findMinion(target);
                        if (typeof toMinionHealthBuff === 'undefined') {
                            playCard = false;
                        }
                        actions.push(function() {
                            toMinionHealthBuff.maxHealth += action[1];
                            toMinionHealthBuff.health += action[1];
                        });
                        break;
                    case 'buff_health_all':
                        actions.push(function() {
                            plr.minions.slice().forEach(function(x) {
                                x.maxHealth += action[1];
                                x.health += action[1];
                            });
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
                            opp.damage(action[1], target);
                        });
                        break;
                    case 'damage_player':
                        actions.push(function() {
                            plr.damage(action[1], target);
                        });
                        break;
                    case 'spawn':
                        actions.push(function() {
                            action[1].forEach(function(minionId) {
                                plr.spawnMinion(minionId, cardId, position);
                            });
                        });
                        break;
                    case 'card_copy':
                        actions.push(function() {
                            var toSteal = Math.min(action[1], opp.hand.length);
                            for (var i = 0; i < toSteal; i++) {
                                plr.addCard(opp.hand[i]);
                            }
                        });
                        break;
                    case 'if':
                        if(action[1](targetObject)) {
                            var subActions = plr.processActions(action[2], target, cardId, position);
                            if (subActions === false) {
                                playCard = false;
                            }
                            else {
                                subActions.forEach((x) => actions.push(x));
                            }
                        }
                        else {
                            playCard = false;
                        }
                        break;
                    case 'silence':
                        if (targetObject.isMinion) {
                            actions.push(function() {
                                targetObject.removeAllAttributes();
                            });
                        }
                        else {
                            playCard = false;
                        }
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
};

Player.prototype.playCard = function(cardId, target, position) {
    if (typeof position === 'undefined') {
        position = this.minions.length;
    }
    const game = this.game;
    if (game && !game.ended) {
        var cardInfo = constants.cards[cardId];
        var cardIndex = this.hand.indexOf(parseInt(cardId));
        if (this.game.turn != this.id) {
            this.sendError("It is not currently your turn!");
            return false;
        }
        if (typeof cardInfo == 'undefined') {
            console.warn('Player tried playing invalid card: ' + cardId);
            this.sendError("You tried playing an invalid card!");
            return false;
        }
        if (cardInfo.mana > this.mana) {
            this.sendError("You do not have enough mana to play this card!");
            return false;
        }
        if (cardInfo.target && typeof target !== 'number' && typeof target !== 'string') {
            if (typeof target === 'undefined') {
                this.sendError("This card requires a target to be played on!");
            }
            else {
                this.sendError("Invalid type passed to playCard function!");
            }
            return false;
        }
        if (cardIndex <= -1) {
            console.warn('Player tried playing unavailable card: ' + cardId + ' (' + cardInfo.name + ', index: ' + cardIndex + '), only has ' + this.hand);
            this.sendError("You do not have this card!");
            return false;
        }
        const plr = this;
        const game = this.game;
        const opp = game.getOpponent(plr);
        var actions = plr.processActions(cardInfo.actions, target, cardId, position);
        if (actions === false) {
            this.sendError("Cannot play this card in this situation!");
            return false;
        }
        switch (cardInfo.type) {
            case 'minion':
                if (plr.minions.length >= constants.player.MAX_MINIONS) {
                    this.sendError("Cannot play this card, board is full!");
                    return false;
                }
                actions.push(function() {
                    cardInfo.spawn.forEach(function(minionId) {
                        plr.spawnMinion(minionId, cardId, position);
                    });
                });
                break;
            case 'spell':
                break;
            default:
                console.warn('Unknown card type: ' + cardInfo.type);
                break;
        }

        // remove card
        this.hand.splice(cardIndex, 1);

        // process card events
        this.minions.forEach(function(minion) {
            if (minion.events && minion.events.player_play_card) {
                var eventActions = plr.processActions(minion.events.player_play_card, minion.minionInstanceId, minion.cardId);
                if (eventActions === false) {
                    throw new Error('Error occured while processing minion -> player play card events!');
                }
                eventActions.forEach((x) => actions.push(x));
            }
        });
        opp.minions.forEach(function(minion) {
            if (minion.events && minion.events.opponent_play_card) {
                var eventActions = opp.processActions(minion.events.opponent_play_card, minion.minionInstanceId, minion.cardId);
                if (eventActions === false) {
                    throw new Error('Error occured while processing opponent minion -> player play card events!');
                }
                eventActions.forEach((x) => actions.push(x));
            }
        });

        // process card actions
        actions.forEach((x) => x());

        // deduct mana cost
        this.mana -= cardInfo.mana;
        game.sendPacket("playCard", {
            playerMana: this.mana,
            playerId: this.id,
            cardId: cardId
        });
        return true;
    }
    else {
        throw new Error("Tried to play card while not in game!");
    }
};

/*
 * Add a player to the queue of players searching for a game or start a new game with 2 players.
 */
Player.prototype.addToQueue = function() {
    if (this.game) {
        throw new Error('Player is already in a game!');
    }
    if (queued.length > 0) {
        var opponent = queued.pop();
        var game = new Game(this, Player.get(opponent));
        game.init();
    }
    else {
        queued.push(this.id);
    }
};

Player.prototype.removeFromQueue = function() {
    var playerIndex = queued.indexOf(this.id);
    if (playerIndex > -1) {
        queued.splice(playerIndex, 1);
        return true;
    }
    return false;
};

Player.prototype.isInQueue = function() {
    return queued.indexOf(this.id) > -1;
};

Player.prototype.cleanup = function() {};

module.exports = Player;
