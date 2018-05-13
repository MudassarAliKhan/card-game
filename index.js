#!/usr/bin/env nodejs

const express = require('express');
const ws = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

const Player = require('./player.js');
const Bot = require('./bot.js');
const Game = require('./game.js');
const constants = require('./public/js/constants.js');

wss.on('connection', function(ws) {
    var player;
    ws.on('message', function(message) {
        var data = JSON.parse(message);
        switch (data.type) {
            case 'auth':
                var username = data.data;
                player = new Player(ws);
                if (player.authenticate(username)) {
                    console.log(`Player connected: ${username} (${ws._socket.remoteAddress})`);
                    player.setGameState("lobby");
                }
                else {
                    player.disconnect("Authentication failed!");
                }
                break;
            case 'queue':
                player.setGameState("queued");
                player.addToQueue();
                break;
            case 'playBot':
                var game = new Game(player, new Bot());
                game.init();
                break;
            case 'dequeue':
                player.removeFromQueue();
                player.setGameState("lobby");
                break;
            case 'endTurn':
                player.game.switchTurns(player.id);
                break;
            case 'playCard':
                player.playCard(data.data.card, data.data.target, data.data.position);
                break;
            case 'doMulligan':
                player.doMulligan(data.data);
                break;
            case 'doAttack':
                player.doAttack(data.data.from, data.data.to);
                break;
            case 'loadCards':
                player.sendPacket("loadCards", player.getCards().sort((x, y) => constants.cards[x].mana - constants.cards[y].mana));
                break;
            default:
                console.log(`Unknown Packet: ${JSON.stringify(data)}`);
                break;
        }
    });
    ws.on('close', () => {
        if (player) {
            player.disconnect();
        }
    });
});

app.use(express.static('public'));

server.listen(process.env.PORT || 5000, () => {
    console.log(`Server started on port ${server.address().port}...`);
});
