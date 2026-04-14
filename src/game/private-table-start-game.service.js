// src/game/private-table-start-game.service.js

const gameStateManager = require('../state/game-state');
const Deck = require('../engine/deck');
const StartGameBuilder = require('./start-game.builder');
const tableManager = require('../table/table-manager.service');
const mongoHelper = require('../models/customdb');
const { emitSuccess } = require('../websocket/socket-emitter');
const privateTableGameConfig = require('../services/private-table-game-config.service');

class PrivateTableStartGameService {
    constructor(io, timerManager) {
        this.io = io;
        this.timerManager = timerManager;
    }

    normalizeAmount(value) {
        const amount = Number(value || 0);
        if (!Number.isFinite(amount)) {
            return 0;
        }

        const normalized = Math.round((amount + Number.EPSILON) * 100) / 100;
        return Math.abs(normalized) < 0.000001 ? 0 : normalized;
    }

    async start(tableId) {
        console.log(`🎲 [PRIVATE GAME START] Initializing hand for table ${tableId}`);
        const locked = await gameStateManager.acquireLock(tableId);
        if (!locked) throw new Error('Table busy');

        let gameState;

        try {
            // Get private table configuration
            const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
            
            if (!privateConfig) {
                // Fall back to regular game start if not a private table
                const StartGameService = require('./start-game-service');
                const regularService = new StartGameService(this.io, this.timerManager);
                return await regularService.start(tableId);
            }

            console.log(`🔧 [PRIVATE CONFIG] Using private table config:`, {
                gameType: privateConfig.gameType,
                stakes: privateConfig.config.stakes?.type,
                blinds: privateConfig.gameConfig.blinds,
                timer: privateConfig.gameConfig.timer.turnTimer
            });

            const tableState = await tableManager.getTable(tableId);
            
            // Remove ghost players
            tableState.players = tableState.players.filter(p => p.chips && p.chips > 0);

            if (tableState.players.length < privateConfig.gameConfig.players.min) {
                throw new Error(`Not enough players (minimum ${privateConfig.gameConfig.players.min})`);
            }

            // Use private table blinds
            const smallBlindAmount = privateConfig.gameConfig.blinds.small;
            const bigBlindAmount = privateConfig.gameConfig.blinds.big;

            console.log(`🎴 [PRIVATE BLINDS] SB: ${smallBlindAmount}, BB: ${bigBlindAmount}, Type: ${privateConfig.gameConfig.stakes.type}`);

            gameState = StartGameBuilder.buildInitialState({
                tableId,
                seatedPlayers: tableState.players,
                smallBlind: smallBlindAmount,
                bigBlind: bigBlindAmount,
                dealerPosition: tableState.dealerPosition
            });

            // Apply private table specific configurations
            gameState.privateTableConfig = privateConfig.gameConfig;
            gameState.lastRaiseAmount = bigBlindAmount;

            // Initialize tracking maps
            gameState.players.forEach(p => {
                gameState.streetBets[p.id] = 0;
                gameState.totalContributions[p.id] = 0;
            });

            // Handle antes if enabled
            if (privateConfig.gameConfig.features.antesEnabled) {
                const antesResult = privateTableGameConfig.calculateAntes(privateConfig.gameConfig, gameState.players);
                gameState.antes = antesResult.antes;
                gameState.anteValue = antesResult.anteAmount || 0;
                gameState.pot = this.normalizeAmount((gameState.pot || 0) + (antesResult.totalAntes || 0));
                
                gameState.players.forEach(p => {
                    const anteAmount = antesResult.antes[p.id] || 0;
                    if (anteAmount > 0) {
                        p.chips = this.normalizeAmount(p.chips - anteAmount);
                        gameState.totalContributions[p.id] = this.normalizeAmount((gameState.totalContributions[p.id] || 0) + anteAmount);
                        if (p.chips === 0) {
                            p.status = 'ALL_IN';
                        }
                    }
                });

                gameState.totalAntes = antesResult.totalAntes;
                console.log(`🎯 [ANTES] Posted ${antesResult.totalAntes} in antes`);
            }

            // Deduct blinds
            gameState.players.forEach(p => {
                if (p.seatPosition === gameState.smallBlindPosition) {
                    const amount = Math.min(smallBlindAmount, p.chips);
                    p.chips = this.normalizeAmount(p.chips - amount);
                    gameState.streetBets[p.id] = this.normalizeAmount((gameState.streetBets[p.id] || 0) + amount);
                    gameState.totalContributions[p.id] = this.normalizeAmount((gameState.totalContributions[p.id] || 0) + amount);
                    if (p.chips === 0) {
                        p.status = 'ALL_IN';
                    }
                }

                if (p.seatPosition === gameState.bigBlindPosition) {
                    const amount = Math.min(bigBlindAmount, p.chips);
                    p.chips = this.normalizeAmount(p.chips - amount);
                    gameState.streetBets[p.id] = this.normalizeAmount((gameState.streetBets[p.id] || 0) + amount);
                    gameState.totalContributions[p.id] = this.normalizeAmount((gameState.totalContributions[p.id] || 0) + amount);
                    gameState.currentBet = this.normalizeAmount(amount);
                    if (p.chips === 0) {
                        p.status = 'ALL_IN';
                    }
                }
            });

            // Deal cards
            gameState.deck = Deck.generate();
            gameState.players.forEach(player => {
                player.cards = [
                    gameState.deck.pop(),
                    gameState.deck.pop()
                ];
            });

            gameState.currentPlayerId = this.getFirstPlayerAfterBigBlind(gameState);

            await gameStateManager.createGame(tableId, gameState);
            await tableManager.syncFromGameState(tableId, gameState);
            await tableManager.setStatus(tableId, 'IN_PROGRESS');
            const syncedTableState = await tableManager.getTable(tableId);

            // ✅ CRITICAL: Emit standard gameStarted event for client compatibility
            emitSuccess(
                this.io.to(tableId),
                'gameStarted',
                this.formatGameStartData(syncedTableState, gameState),
                'Game started successfully'
            );

            // Emit private table specific event with additional config
            emitSuccess(
                this.io.to(tableId),
                'privateGameStarted',
                {
                    ...this.formatGameStartData(syncedTableState, gameState),
                    privateTableConfig: {
                        gameType: privateConfig.gameType,
                        stakes: privateConfig.gameConfig.stakes,
                        features: privateConfig.gameConfig.features,
                        timer: privateConfig.gameConfig.timer
                    }
                },
                'Private table game started successfully'
            );

            // Emit standard events
            this.emitGameEvents(tableId, syncedTableState, gameState, smallBlindAmount, bigBlindAmount);

            console.log(`✅ [PRIVATE GAME STARTED] First turn: ${gameState.currentPlayerId}`);

        } catch (err) {
            console.error(`❌ Private game start error for ${tableId}:`, err.message);
            throw err;
        } finally {
            await gameStateManager.releaseLock(tableId);
        }

        if (gameState) {
            // Use private table timer settings
            const timerSeconds = gameState.privateTableConfig?.timer?.turnTimer || 30;
            await this.timerManager.startTimer(tableId, gameState.currentPlayerId, timerSeconds);
        }
    }

    getFirstPlayerAfterBigBlind(gameState) {
        const active = gameState.players
            .filter(p => p.status === 'ACTIVE')
            .sort((a, b) => a.seatPosition - b.seatPosition);

        const bbIndex = active.findIndex(
            p => p.seatPosition === gameState.bigBlindPosition
        );

        return active[(bbIndex + 1) % active.length].id;
    }

    emitGameEvents(tableId, tableState, gameState, smallBlindAmount, bigBlindAmount) {
        // Dealer assignment
        emitSuccess(
            this.io.to(tableId),
            'dealerAssigned',
            {
                position: gameState.dealerPosition,
                player: gameState.players.find(p => p.seatPosition === gameState.dealerPosition)
            },
            'Dealer assigned'
        );

        // Small blind
        emitSuccess(
            this.io.to(tableId),
            'smallBlind',
            { 
                position: gameState.smallBlindPosition, 
                smallBlind: smallBlindAmount,
                player: gameState.players.find(p => p.seatPosition === gameState.smallBlindPosition)
            },
            'Small blind posted'
        );

        // Big blind
        emitSuccess(
            this.io.to(tableId),
            'bigBlind',
            { 
                position: gameState.bigBlindPosition, 
                bigBlind: bigBlindAmount,
                player: gameState.players.find(p => p.seatPosition === gameState.bigBlindPosition)
            },
            'Big blind posted'
        );

        // Antes if any
        if (gameState.totalAntes > 0) {
            emitSuccess(
                this.io.to(tableId),
                'antesPosted',
                { 
                    anteValue: gameState.anteValue || 0,
                    totalAntes: gameState.totalAntes,
                    players: gameState.players
                        .filter(player => (gameState.antes?.[player.id] || 0) > 0)
                        .map(player => ({
                            userId: player.id,
                            seatPosition: player.seatPosition,
                            ante: gameState.antes[player.id]
                        }))
                },
                'Antes posted'
            );
        }

        // Deal hands
        tableState.players.forEach(tablePlayer => {
            const player = gameState.players.find(gamePlayer => gamePlayer.id === tablePlayer.userId);
            if (!player || !tablePlayer.socketId) {
                return;
            }

            emitSuccess(
                this.io.to(tablePlayer.socketId),
                'receiveHand',
                {
                    playerId: player.id,
                    hand: player.cards
                },
                'Hand dealt'
            );
        });
    }

    formatGameStartData(tableState, gameState) {
        const formattedPlayers = tableState.players.map(player => {
            const gamePlayer = gameState.players.find(p => p.id === player.userId);
            return {
                _id: player.userId,
                username: player.username,
                chips: player.chips,
                seatPosition: player.seatPosition,
                status: gamePlayer?.status || 'ACTIVE',
                socketId: player.socketId,
                isAway: player.isAway || false,
                currentRoundBet: gameState.streetBets[player.userId] || 0
            };
        });

        return {
            maxPlayers: gameState.privateTableConfig?.players?.max || tableState.maxPlayers || 9,
            currentPlayers: formattedPlayers,
            gameState: {
                pot: gameState.pot || 0,
                phase: gameState.phase,
                currentPlayerId: gameState.currentPlayerId,
                currentBet: gameState.currentBet || 0,
                boardCards: gameState.boardCards || [],
                dealerPosition: gameState.dealerPosition,
                smallBlindPosition: gameState.smallBlindPosition,
                bigBlindPosition: gameState.bigBlindPosition,
                totalAntes: gameState.totalAntes || 0,
                anteValue: gameState.anteValue || 0
            }
        };
    }
}

module.exports = PrivateTableStartGameService;
