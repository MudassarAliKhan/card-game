#!/usr/bin/env nodejs

const express = require('express');
const ws = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

const Player = require('./player.js');

wss.on('connection', function(ws) {
    var player;
    ws.on('message', function(message) {
        var data = JSON.parse(message);
        switch (data.type) {
            case 'auth':
                var username = data.data;
                player = new Player(ws);
                if (player.authenticate(username)) {
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
            default:
                console.log('Unknown Packet: ' + data);
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
