const gameStateManager = require('../state/game-state');
const Deck = require('../engine/deck');
const StartGameBuilder = require('./start-game.builder');
const tableManager = require('../table/table-manager.service');
const mongoHelper = require('../models/customdb');
const { emitSuccess } = require('../websocket/socket-emitter');
const provablyFairService = require('../services/provably-fair.service');
const provablyFairSessionService = require('../services/provably-fair-session.service');

class StartGameService {
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

    formatCards(cards = []) {
        return cards.map(card => `${card.cardFace}${card.suit?.[0] || ''}`);
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

    async start(tableId, fairnessContext = null) {
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
            
            // Check if this is a tournament table
            if (matchmakingTable.data.isTournament && matchmakingTable.data.tournamentId) {
                console.log(`ðŸ† [TOURNAMENT] Using tournament blind level`);

                const tournamentResult = await mongoHelper.findById(
                    mongoHelper.COLLECTIONS.TOURNAMENTS,
                    matchmakingTable.data.tournamentId
                );

                if (!tournamentResult.success || !tournamentResult.data) {
                    throw new Error('Tournament configuration not found');
                }

                const currentLevel = tournamentResult.data.currentLevel || matchmakingTable.data.tournamentConfig?.currentLevel;
                if (!currentLevel?.smallBlind || !currentLevel?.bigBlind) {
                    throw new Error('Tournament blind level not configured');
                }

                smallBlindAmount = Number(currentLevel.smallBlind);
                bigBlindAmount = Number(currentLevel.bigBlind);
                console.log(`ðŸŽ´ [TOURNAMENT BLINDS] SB: ${smallBlindAmount}, BB: ${bigBlindAmount}, Ante: ${currentLevel.ante || 0}`);
            } else if (matchmakingTable.data.isPrivate && matchmakingTable.data.privateTableId) {
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
            } else if (matchmakingTable.data.isTournament && matchmakingTable.data.tournamentId) {
                const tournamentResult = await mongoHelper.findById(
                    mongoHelper.COLLECTIONS.TOURNAMENTS,
                    matchmakingTable.data.tournamentId
                );
                const currentLevel = tournamentResult.data.currentLevel || matchmakingTable.data.tournamentConfig?.currentLevel;
                gameState.tournamentConfig = {
                    tournamentId: matchmakingTable.data.tournamentId,
                    tournamentTableId: matchmakingTable.data.tournamentTableId,
                    currentLevel,
                    turnTimer: matchmakingTable.data.tournamentConfig?.turnTimer || 20
                };
            }

            gameState.lastRaiseAmount = bigBlindAmount;

            // Initialize tracking maps
            gameState.players.forEach(p => {
                gameState.streetBets[p.id] = 0;
                gameState.totalContributions[p.id] = 0;
            });

            if (gameState.tournamentConfig?.currentLevel?.ante > 0) {
                const anteAmount = Number(gameState.tournamentConfig.currentLevel.ante || 0);
                gameState.antes = {};
                gameState.anteValue = anteAmount;
                gameState.totalAntes = 0;

                gameState.players.forEach(p => {
                    if (p.status !== 'ACTIVE' || p.chips <= 0) {
                        return;
                    }

                    const postedAnte = this.normalizeAmount(Math.min(anteAmount, p.chips));
                    if (postedAnte <= 0) {
                        return;
                    }

                    p.chips = this.normalizeAmount(p.chips - postedAnte);
                    gameState.antes[p.id] = postedAnte;
                    gameState.totalAntes = this.normalizeAmount((gameState.totalAntes || 0) + postedAnte);
                    gameState.totalContributions[p.id] = this.normalizeAmount((gameState.totalContributions[p.id] || 0) + postedAnte);

                    if (p.chips === 0) {
                        p.status = 'ALL_IN';
                    }
                });

                gameState.pot = this.normalizeAmount((gameState.pot || 0) + gameState.totalAntes);
                console.log(`ðŸ† [TOURNAMENT ANTES] Posted ${gameState.totalAntes} in antes (${anteAmount} each where possible)`);
            } else if (gameState.privateTableConfig?.features?.antesEnabled) {
                const privateTableGameConfig = require('../services/private-table-game-config.service');
                const antesResult = privateTableGameConfig.calculateAntes(gameState.privateTableConfig, gameState.players);

                gameState.antes = antesResult.antes;
                gameState.anteValue = antesResult.anteAmount || 0;
                gameState.totalAntes = antesResult.totalAntes || 0;
                gameState.pot = this.normalizeAmount((gameState.pot || 0) + gameState.totalAntes);

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

                console.log(`🎯 [ANTES] Posted ${gameState.totalAntes} in antes (${gameState.anteValue} each where possible)`);
            }

            // ✅ Deduct blinds into streetBets (NOT pot)
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

            const resolvedFairness = fairnessContext || await provablyFairSessionService.consumeReadyHand(tableId);
            if (!resolvedFairness) {
                throw new Error('Provably fair hand is not ready to start');
            }

            gameState.fairness = provablyFairService.buildPublicCommitment(resolvedFairness);
            gameState.fairnessReveal = provablyFairService.buildReveal(resolvedFairness);
            gameState.deck = Deck.generate(resolvedFairness.finalSeed);
            gameState.fairnessDealOrder = provablyFairService.dealHoleCards({
                deck: gameState.deck,
                players: gameState.players,
                dealerPosition: gameState.dealerPosition
            });
            console.log('[PF][GAME_START_DEAL]', {
                tableId,
                handNumber: resolvedFairness.handNumber,
                finalSeed: resolvedFairness.finalSeed,
                dealerPosition: gameState.dealerPosition,
                smallBlindPosition: gameState.smallBlindPosition,
                bigBlindPosition: gameState.bigBlindPosition,
                dealOrder: gameState.fairnessDealOrder,
                holeCards: gameState.players.map(player => ({
                    playerId: player.id,
                    username: player.username,
                    seatPosition: player.seatPosition,
                    cards: this.formatCards(player.cards || [])
                })),
                remainingDeckCount: gameState.deck.length
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
                'fairnessCommitted',
                gameState.fairness,
                'Provably fair seed committed'
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
            
            if (tableResult?.data?.isTournament && tableResult?.data?.tournamentId) {
                const customTimer = gameState.tournamentConfig?.turnTimer || tableResult.data.tournamentConfig?.turnTimer || 20;
                console.log(`â±ï¸ [TOURNAMENT TIMER] Using timer: ${customTimer}s`);
                await this.timerManager.startTimer(tableId, gameState.currentPlayerId, customTimer);
            } else if (tableResult?.data?.isPrivate && tableResult?.data?.privateTableId) {
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
                anteValue: gameState.anteValue || 0,
                fairness: gameState.fairness || null
            }
        };
    }
}

module.exports = StartGameService;
