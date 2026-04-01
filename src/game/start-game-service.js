const gameStateManager = require('../state/game-state');
const Deck = require('../engine/deck');
const StartGameBuilder = require('./start-game.builder');
const tableManager = require('../table/table-manager.service');
const mongoHelper = require('../models/customdb');
const { emitSuccess } = require('../websocket/socket-emitter');

class StartGameService {
    constructor(io, timerManager) {
        this.io = io;
        this.timerManager = timerManager;
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

    async start(tableId) {
        console.log(`🎲 [GAME START] Initializing hand for table ${tableId}`);
        const locked = await gameStateManager.acquireLock(tableId);
        if (!locked) throw new Error('Table busy');

        let gameState;

        try {
            const matchmakingTable = await mongoHelper.findById(
                mongoHelper.COLLECTIONS.TABLES,
                tableId
            );

            if (!matchmakingTable)
                throw new Error('Matchmaking table not found');
            console.log(matchmakingTable);
            
            let bigBlindAmount, smallBlindAmount;
            
            // Check if this is a private table
            if (matchmakingTable.data.isPrivate && matchmakingTable.data.privateTableId) {
                console.log(`🔒 [PRIVATE TABLE] Using private table configuration`);
                
                // Get private table configuration
                const privateTableGameConfig = require('../services/private-table-game-config.service');
                const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
                
                if (!privateConfig) {
                    throw new Error('Private table configuration not found');
                }
                
                bigBlindAmount = privateConfig.gameConfig.blinds.big;
                smallBlindAmount = privateConfig.gameConfig.blinds.small;
                console.log(`🎴 [PRIVATE BLINDS] SB: ${smallBlindAmount}, BB: ${bigBlindAmount}, Type: ${privateConfig.gameConfig.blinds.type}`);
            } else {
                // Regular table - use SubTier configuration
                let subTier = await mongoHelper.findById(
                    mongoHelper.COLLECTIONS.SUB_TIERS,
                    matchmakingTable?.data?.subTierId
                );

                if (!subTier)
                    throw new Error('SubTier not found');
                subTier = subTier.data
                
                bigBlindAmount = subTier.tableConfig.bb;
                smallBlindAmount = bigBlindAmount / 2;
                
                console.log(`🎴 [BLINDS POSTED] SB: ${smallBlindAmount}, BB: ${bigBlindAmount}`);
            }
            const tableState = await tableManager.getTable(tableId);

            console.log(`🔍 [DEBUG] Redis tableState:`, JSON.stringify(tableState, null, 2));
            console.log(`🔍 [DEBUG] Players count: ${tableState.players.length}`);
            console.log(`🔍 [DEBUG] Players:`, tableState.players.map(p => ({ userId: p.userId, chips: p.chips })));

            // Remove ghost players
            tableState.players = tableState.players.filter(
                p => p.chips && p.chips > 0
            );

            console.log(`🔍 [DEBUG] After filter - Players count: ${tableState.players.length}`);

            if (tableState.players.length < 2) {
                throw new Error('Not enough players');
            }

            gameState = StartGameBuilder.buildInitialState({
                tableId,
                seatedPlayers: tableState.players,
                smallBlind: smallBlindAmount,
                bigBlind: bigBlindAmount,
                dealerPosition: tableState.dealerPosition
            });

            if (matchmakingTable.data.isPrivate && matchmakingTable.data.privateTableId) {
                const privateConfig = await require('../services/private-table-game-config.service').getPrivateTableGameConfig(tableId);
                if (privateConfig) {
                    gameState.privateTableConfig = privateConfig.gameConfig;
                }
            }

            gameState.lastRaiseAmount = bigBlindAmount;

            // Initialize tracking maps
            gameState.players.forEach(p => {
                gameState.streetBets[p.id] = 0;
                gameState.totalContributions[p.id] = 0;
            });

            if (gameState.privateTableConfig?.features?.antesEnabled) {
                const privateTableGameConfig = require('../services/private-table-game-config.service');
                const antesResult = privateTableGameConfig.calculateAntes(gameState.privateTableConfig, gameState.players);

                gameState.antes = antesResult.antes;
                gameState.anteValue = antesResult.anteAmount || 0;
                gameState.totalAntes = antesResult.totalAntes || 0;

                gameState.players.forEach(p => {
                    const anteAmount = antesResult.antes[p.id] || 0;
                    if (anteAmount > 0) {
                        p.chips -= anteAmount;
                        gameState.streetBets[p.id] += anteAmount;
                        gameState.totalContributions[p.id] += anteAmount;
                    }
                });

                console.log(`🎯 [ANTES] Posted ${gameState.totalAntes} in antes (${gameState.anteValue} each where possible)`);
            }

            // ✅ Deduct blinds into streetBets (NOT pot)
            gameState.players.forEach(p => {
                if (p.seatPosition === gameState.smallBlindPosition) {
                    const amount = Math.min(smallBlindAmount, p.chips);
                    p.chips -= amount;

                    gameState.streetBets[p.id] += amount;
                    gameState.totalContributions[p.id] += amount;
                }

                if (p.seatPosition === gameState.bigBlindPosition) {
                    const amount = Math.min(bigBlindAmount, p.chips);
                    p.chips -= amount;

                    gameState.streetBets[p.id] += amount;
                    gameState.totalContributions[p.id] += amount;

                    gameState.currentBet = amount;
                }
            });

            gameState.deck = Deck.generate();

            gameState.players.forEach(player => {
                player.cards = [
                    gameState.deck.pop(),
                    gameState.deck.pop()
                ];
            });

            gameState.currentPlayerId = this.getFirstPlayerAfterBigBlind(gameState);
            console.log(`🎴 [BLINDS POSTED] SB: ${smallBlindAmount}, BB: ${bigBlindAmount}`);
            console.log(`🎴 [CARDS DEALT] ${gameState.players.length} players`);

            await gameStateManager.createGame(tableId, gameState);
            await tableManager.syncFromGameState(tableId, gameState);
            await tableManager.setStatus(tableId, 'IN_PROGRESS');
            const syncedTableState = await tableManager.getTable(tableId);
            
            // Debug: Verify gameState was created
            const verifyGameState = await gameStateManager.getGame(tableId);
            if (verifyGameState) {
                console.log(`✅ [GAME STATE] Successfully created and verified for table ${tableId}`);
                console.log(`🎯 [GAME STATE] Current player: ${verifyGameState.currentPlayerId}`);
            } else {
                console.error(`❌ [GAME STATE] Failed to create or retrieve gameState for table ${tableId}`);
            }

            emitSuccess(
                this.io.to(tableId),
                'gameStarted',
                this.formatGameStartData(syncedTableState, gameState),
                'Game started successfully'
            );

            emitSuccess(
                this.io.to(tableId),
                'dealerAssigned',
                {
                    position: gameState.dealerPosition,
                    player: gameState.players.find(p => p.seatPosition === gameState.dealerPosition)
                },
                'Dealer assigned'
            );

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

            if ((gameState.totalAntes || 0) > 0) {
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

            syncedTableState.players.forEach(tablePlayer => {
                const gamePlayer = gameState.players.find(player => player.id === tablePlayer.userId);
                if (!gamePlayer || !tablePlayer.socketId) {
                    return;
                }

                emitSuccess(
                    this.io.to(tablePlayer.socketId),
                    'receiveHand',
                    {
                        playerId: gamePlayer.id,
                        hand: gamePlayer.cards
                    },
                    'Hand dealt'
                );
            });

            console.log(`✅ [GAME STARTED] First turn: ${gameState.currentPlayerId}`);

        } catch (err) {
            console.error(`❌ start game error for ${tableId}:`, err.message);
            throw err;
        } finally {
            await gameStateManager.releaseLock(tableId);
        }

        if (gameState) {
            // Check if this is a private table and use custom timer
            const tableResult = await mongoHelper.findById(
                mongoHelper.COLLECTIONS.TABLES,
                tableId
            );
            
            if (tableResult?.data?.isPrivate && tableResult?.data?.privateTableId) {
                const privateTableGameConfig = require('../services/private-table-game-config.service');
                const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
                
                if (privateConfig && privateConfig.gameConfig.timer) {
                    const customTimer = privateConfig.gameConfig.timer.turnTimer || 30;
                    console.log(`⏱️ [PRIVATE TIMER] Using custom timer: ${customTimer}s`);
                    await this.timerManager.startTimer(tableId, gameState.currentPlayerId, customTimer);
                } else {
                    await this.timerManager.startTimer(tableId, gameState.currentPlayerId);
                }
            } else {
                await this.timerManager.startTimer(tableId, gameState.currentPlayerId);
            }
        }
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
            maxPlayers: tableState.maxPlayers || 9,
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

module.exports = StartGameService;
