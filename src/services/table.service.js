const httpStatus = require('http-status');
const mongoHelper = require('../models/customdb');
// const gameStateManager = require('./gameStateManager');
const ApiError = require('../utils/ApiError');
// const botEmitter = require('../utils/botEventEmitter');
// const tableJoinQueue = require('./tableJoinQueue.service');
// const { createTableOnBlockchain, transferFromPoolToTable } = require('./blockchain.service.js'); // Will Implement later
const { updateUserHandStats, getPlayerInfoByTypeId, createInitialUserStats } = require('./player.service.js'); // Will implement later
// const { updateUserHandStats } = require('./player.service.js'); // Will implement later
// const { handleTableTurnover } = require('../services/user.service');
const blockchainService = require('../services/blockchain.service');
const reputationService = require('../services/reputation.service');
const { SubTier, MatchmakingTable } = require('../models/matchmaking.model');
const { Table } = require('../models/table.model');


const INACTIVE_THRESHOLD_MINUTES = 10; // match socket.js INACTIVE_MINUTES
const INACTIVE_MINUTES = 5;

const getAvailableActions = async (
    player,
    highestBet,
    playerBet,
    pot,
    smallBlind,
    bigBlind,
    gameStates,
    tableId,
    table
) => {
    const updatedTable = await getTableById(table._id);
    const updatedPlayerResult = await getPlayerInfoByTypeId('socketId', player.socketId);

    if (!updatedTable || !updatedPlayerResult) {
        throw new Error('Could not retrieve updated table or player data');
    }

    table = updatedTable;
    player = updatedPlayerResult;

    const gameStateResult = await mongoHelper.find(mongoHelper.COLLECTIONS.GAME_STATES, {
        _id: updatedTable.gameState._id || updatedTable.gameState,
    });
    if (!gameStateResult.success) {
        throw new Error('Could not retrieve game state');
    }

    const gameState = gameStateResult.data[0];
    const roomId = tableId.toString();

    table.currentPlayers.forEach((p, index) => {
        // Log player details for debugging
    });

    const options = new Set();
    let callAmount = highestBet - playerBet;

    if (player.status === 'small-blind' && playerBet === 0) {
        callAmount -= smallBlind;
    }
    callAmount = Math.max(callAmount, 0);

    const lastRaiseAmount = gameStates[tableId]?.lastRaiseAmount || bigBlind;

    const activePlayers = table.currentPlayers
        .filter(
            p =>
                p.status !== 'folded' &&
                p.status !== 'waiting' &&
                p.status !== 'pending-rebuy' &&
                p.status !== 'all-in' &&
                p._id.toString() !== player._id.toString()
        )
        .map(p => ({
            chips: p.chipsInPlay,
            alreadyBet: gameStates[roomId].playerBets?.[p.socketId] || 0,
        }));

    const playerEffectiveStack = player.chipsInPlay - callAmount;
    const playerTotalChips = player.chipsInPlay + playerBet;

    let minRaiseAmount;
    if (highestBet === bigBlind) {
        minRaiseAmount = bigBlind * 2;
    } else if (highestBet > 0) {
        const minIncrement = Math.max(lastRaiseAmount, bigBlind);
        minRaiseAmount = highestBet + minIncrement;
    } else {
        minRaiseAmount = bigBlind;
    }

    const allPlayerStacks = [...activePlayers.map(p => p.chips + p.alreadyBet), playerTotalChips];
    const effectiveStacks = allPlayerStacks.sort((a, b) => b - a);

    const limitingStack = effectiveStacks.length > 1 ? effectiveStacks[1] : effectiveStacks[0];

    const maxPossibleRaise = playerTotalChips > limitingStack ? limitingStack : playerTotalChips;

    minRaiseAmount = Math.min(minRaiseAmount, maxPossibleRaise);
    const maxRaiseAmount = maxPossibleRaise;

    if (minRaiseAmount > player.chipsInPlay) {
        options.delete('raise');
    }

    // Determine available options
    if (player.status !== 'all-in') {
        options.add('fold');

        if (callAmount === 0) {
            options.add('check');

            if (playerEffectiveStack >= minRaiseAmount && activePlayers.length > 0) {
                options.add('raise');
            }
        } else {
            if (player.chipsInPlay < callAmount) {
                if (player.chipsInPlay > 0) {
                    options.add('all-in');
                }
            } else {
                options.add('call');

                const chipsAfterCall = player.chipsInPlay - callAmount;
                const hasAllInPlayer = table.currentPlayers.some(p => p.status === 'all-in');

                const allInAmount = hasAllInPlayer
                    ? Math.max(
                        ...table.currentPlayers
                            .filter(p => p.status === 'all-in')
                            .map(p => gameState.players.find(gp => gp.playerId.toString() === p._id.toString())?.chipsInPot || 0)
                    )
                    : 0;

                if (chipsAfterCall >= bigBlind && activePlayers.length > 0) {
                    options.add('raise');
                }
            }
        }
    }

    // Calculate bet increment
    let betIncrement;
    if (bigBlind <= 20) {
        betIncrement = bigBlind;
    } else if (bigBlind <= 100) {
        betIncrement = Math.ceil(bigBlind / 2);
    } else {
        betIncrement = Math.ceil(bigBlind / 4);
    }

    // Calculate raise steps if raise is an option
    let raiseSteps = null;
    if (options.has('raise')) {
        raiseSteps = calculateRaiseSteps(
            minRaiseAmount,
            maxRaiseAmount,
            pot,
            player.chipsInPlay,
            playerTotalChips,
            effectiveStacks
        );
    }

    return {
        options: Array.from(options),
        callAmount: callAmount > 0 ? callAmount : null,
        minRaiseAmount: options.has('raise') ? minRaiseAmount : null,
        maxRaiseAmount: options.has('raise') ? maxRaiseAmount : null,
        raiseSteps,
        betIncrement,
    };
};

function calculateRaiseSteps(minRaise, maxRaise, pot, playerChips, playerTotalChips, effectiveStacks = []) {
    const halfPot = pot * 0.5;
    const fullPot = pot;

    let steps = [
        { label: '1/2 Pot', value: Math.min(maxRaise, Math.max(minRaise, halfPot)) },
        { label: 'Full Pot', value: Math.min(maxRaise, Math.max(minRaise, fullPot)) },
    ];

    const isMaxChipHolder =
        effectiveStacks.length > 0 &&
        playerTotalChips === effectiveStacks[0] &&
        effectiveStacks.filter(s => s === playerTotalChips).length === 1;

    if (!isMaxChipHolder) {
        steps.push({ label: 'All-In', value: playerChips });
    }

    return steps.filter(step => step.value >= minRaise && step.value <= playerChips).sort((a, b) => a.value - b.value);
}

const getNextPlayerInTurn = async (table, isStartGame = false, isNewPhase = false) => {
    try {
        const refreshedTable = await getTableById(table._id);

        // ✅ CRITICAL FIX: Filter out players who cannot act
        // During game start, include 'waiting' players; otherwise exclude them
        const statusesToExclude = isStartGame 
            ? ['folded', 'pending-rebuy', 'left']
            : ['folded', 'waiting', 'pending-rebuy', 'left'];
        
        const activePlayers = refreshedTable.currentPlayers.filter(
            player => !statusesToExclude.includes(player.status)
        );

        // Players who can actually take actions (exclude all-in)
        const actionablePlayers = activePlayers.filter(
            player => player.status !== 'all-in' && player.chipsInPlay > 0
        );

        console.log(`🔍 [getNextPlayerInTurn] Players - Active: ${activePlayers.length}, Actionable: ${actionablePlayers.length}`);

        if (isStartGame && activePlayers.length < 2) {
            throw new Error('Not enough active players to continue.');
        }

        // If no actionable players remain, return null (game should go to showdown)
        if (actionablePlayers.length === 0) {
            console.log(`⚠️ [getNextPlayerInTurn] No actionable players remaining`);
            return null;
        }

        // If only 1 actionable player remains, return null (hand should end)
        if (actionablePlayers.length === 1 && !isStartGame) {
            console.log(`⚠️ [getNextPlayerInTurn] Only 1 actionable player remaining: ${actionablePlayers[0].user?.username}`);
            return null;
        }

        // ✅ FIXED: Use maximum seat position instead of player count
        const maxSeatPosition = Math.max(...refreshedTable.currentPlayers.map(p => p.seatPosition));
        let startingPosition;

        if (isStartGame) {
            const bigBlindPlayer = refreshedTable.currentPlayers.find(p => p.status === 'big-blind');
            if (!bigBlindPlayer) throw new Error('Big blind player not found.');
            startingPosition = bigBlindPlayer.seatPosition;
        } else if (isNewPhase) {
            startingPosition = refreshedTable.dealerPosition;
        } else {
            startingPosition = refreshedTable.currentTurnPosition;
        }

        let nextPlayerPosition = startingPosition;
        let iterations = 0;

        do {
            // ✅ FIXED: Use maxSeatPosition instead of totalSeats
            nextPlayerPosition = (nextPlayerPosition % maxSeatPosition) + 1;
            iterations++;
            if (iterations > maxSeatPosition) {
                console.warn(`⚠️ [getNextPlayerInTurn] No valid players found after ${iterations} iterations`);
                return null;
            }
        } while (!actionablePlayers.some(p => p.seatPosition === nextPlayerPosition));

        const nextPlayer = actionablePlayers.find(p => p.seatPosition === nextPlayerPosition);

        if (!nextPlayer) {
            console.warn(`⚠️ [getNextPlayerInTurn] No next player found at position ${nextPlayerPosition}`);
            return null;
        }

        if (!nextPlayer.user || !nextPlayer.user.username) {
            console.error('Player user data not fully populated!', nextPlayer);
            const fullPlayerResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.PLAYERS, nextPlayer._id, [
                {
                    path: 'user',
                    collection: mongoHelper.COLLECTIONS.USERS,
                    select: 'username',
                },
            ]);

            if (fullPlayerResult.success && fullPlayerResult.data.user) {
                nextPlayer.user = fullPlayerResult.data.user;
            } else {
                console.error('Failed to populate player user data!');
                throw new Error('Failed to get player information');
            }
        }

        await mongoHelper.updateById(
            mongoHelper.COLLECTIONS.TABLES,
            refreshedTable._id,
            { currentTurnPosition: nextPlayer.seatPosition },
            mongoHelper.MODELS.TABLE
        );

        console.log(`✅ [getNextPlayerInTurn] Next Player: ${nextPlayer.user.username}, Seat: ${nextPlayer.seatPosition}`);
        return nextPlayer;
    } catch (error) {
        console.error(`❌ [getNextPlayerInTurn] Error: ${error.message}`);
        return null; // Return null instead of throwing to allow graceful handling
    }
};

function mapRoundToPhase(currentRound, boardCardsLength) {
    // Map your currentRound number to phase strings
    if (currentRound === 0 || boardCardsLength === 0) return 'preflop';
    if (currentRound === 1 || boardCardsLength === 3) return 'flop';
    if (currentRound === 2 || boardCardsLength === 4) return 'turn';
    if (currentRound === 3 || boardCardsLength === 5) return 'river';
    return 'preflop'; // fallback
}

const randomNames = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];


function toRoomId(tableOrId) {
    if (!tableOrId) return null;
    if (typeof tableOrId === 'string') return tableOrId;
    if (typeof tableOrId === 'object' && tableOrId._id) return tableOrId._id.toString();
    return String(tableOrId);
}

const handleTableTurnover = async (table, gameState, gameStates, socketId, io, externalEliminationLogs = []) => {
    const roomId = table._id.toString();
    console.log(`🔄 [handleTableTurnover] ENTRY - Room: ${roomId}`);
    console.log(`📊 [handleTableTurnover] Initial state:`, {
        isProcessingTurnover: gameStates[roomId]?.isProcessingTurnover,
        playerCount: table.currentPlayers?.length,
        gameRoundsCompleted: table.gameRoundsCompleted
    });

    // ✅ REMOVED LOCK - caller already holds lock
    if (gameStates[roomId]?.isProcessingTurnover) {
        console.log(`🔒 [handleTableTurnover] Turnover already in progress for room ${roomId}, skipping`);
        return { message: 'Turnover already in progress', status: false };
    }

    if (!gameStates[roomId]) {
        gameStates[roomId] = {};
    }
    gameStates[roomId].isProcessingTurnover = true;

    // Update cooldowns for all players at start of turnover
    const cooldownService = require('./cooldown.service');
    const participantIds = table.currentPlayers
        .filter(p => p.user && p.user._id)
        .map(p => p.user._id.toString());
    
    if (participantIds.length > 1 && table.subTierId) {
        try {
            const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, table.subTierId);
            if (subTierResult.success && subTierResult.data && subTierResult.data.tierId) {
                await cooldownService.updateCooldownsOnSeat(
                    table._id,
                    subTierResult.data.tierId,
                    participantIds
                );
                console.log(`Updated cooldowns for ${participantIds.length} players in turnover`);
            }
        } catch (cooldownError) {
            console.error(`Error updating cooldowns:`, cooldownError.message);
        }
    }

    try {
        const eliminationLogs = [...(Array.isArray(externalEliminationLogs) ? externalEliminationLogs : [])];

        console.log(`🔄 [handleTableTurnover] Initiating main table turnover transaction for Room: ${roomId}`);
        console.log(`📊 [handleTableTurnover] Elimination logs count: ${eliminationLogs.length}`);

        const processingFlag = gameStates[roomId].isProcessingTurnover;
        const _roomId = toRoomId(table); // normalize
        // ✅ CRITICAL FIX: Clear deck so fresh one is generated in next game
        gameStates[_roomId] = {
            ...(gameStates[_roomId] || {}),
            deck: [], // Clear old deck
            dealtCards: {},
            playerBets: {},
            nextPlayerOptions: null,
            lastRaiseAmount: null,
            sidePots: [],
            isProcessingTurnover: true,
        };

        const previousRoundHistory = [...gameState.actionHistory];
        const newRoundNumber = table.gameRoundsCompleted + 2;

        const roundSeparator = [
            { event: '----------------------------------------' },
            { event: `Round ${newRoundNumber} Starting` },
            { event: '----------------------------------------' },
        ];

        const newGameStateData = {
            tableId: table._id,
            boardCards: [],
            currentBet: 0,
            pot: 0,
            currentRound: 0,
            status: 'waitingForPlayers',
            players: [],
            actionHistory: [...previousRoundHistory, ...eliminationLogs, ...roundSeparator],
        };

        const playerChipsLog = [];
        for (const player of table.currentPlayers) {
            const playerResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.PLAYERS, player._id, [
                {
                    path: 'user',
                    collection: mongoHelper.COLLECTIONS.USERS,
                    select: 'username',
                },
            ]);

            if (playerResult.success) {
                playerChipsLog.push({
                    username: playerResult.data.user.username,
                    previousChips: playerResult.data.chipsInPlay,
                    userId: playerResult.data.user._id,
                });
            }
        }

        for (const player of table.currentPlayers) {
            const playerResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.PLAYERS, player._id, [
                {
                    path: 'user',
                    collection: mongoHelper.COLLECTIONS.USERS,
                    select: 'username',
                },
            ]);

            if (playerResult.success) {
                const populatedPlayer = playerResult.data;
                const previousChips = populatedPlayer.chipsInPlay;
                const startingChips = gameStates[roomId]?.roundStartingChips?.[populatedPlayer._id.toString()] || previousChips;
                const netProfit = previousChips - startingChips;

                let updateData = {};

                if (populatedPlayer.chipsInPlay < 0) {
                    console.error(
                        `Correcting negative chip balance for ${populatedPlayer.user.username}: ${populatedPlayer.chipsInPlay}`
                    );
                    updateData.chipsInPlay = 0;
                }

                // ✅ CRITICAL FIX: Get table type for minimum chip requirements
                const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId._id || table.tableTypeId);
                const minChipsRequired = tableTypeResult.success && tableTypeResult.data ? tableTypeResult.data.bigBlind * 2.5 : 20;

                // ✅ CRITICAL FIX: Replenish bots OR auto-rebuy players with insufficient chips
                if (populatedPlayer.isBot && populatedPlayer.chipsInPlay < minChipsRequired) {
                    if (tableTypeResult.success && tableTypeResult.data) {
                        updateData.chipsInPlay = tableTypeResult.data.maxBuyIn || 0;
                        updateData.status = 'waiting';
                        console.log(`🤖 Bot ${populatedPlayer.user.username} replenished with ${updateData.chipsInPlay} chips (had ${populatedPlayer.chipsInPlay})`);
                    }
                } else if (!populatedPlayer.isBot && populatedPlayer.chipsInPlay < minChipsRequired) {
                    // ✅ CRITICAL: Check if player has autoRenew enabled
                    if (populatedPlayer.autoRenew && tableTypeResult.success && tableTypeResult.data) {
                        // Auto-rebuy for human player with maxBuyIn amount
                        const rebuyAmount = tableTypeResult.data.maxBuyIn || 0;
                        console.log(`💰 [Auto-Rebuy] Processing for ${populatedPlayer.user.username}, amount: ${rebuyAmount}`);

                        try {
                            const gameService = require('./game.service');
                            const rebuyResult = await gameService.processPlayerRebuy(populatedPlayer, table, io, eliminationLogs);

                            if (rebuyResult) {
                                console.log(`✅ [Auto-Rebuy] Success for ${populatedPlayer.user.username}`);
                                // ✅ CRITICAL FIX: Preserve 'away' status if player was away, otherwise set to 'waiting'
                                updateData.status = populatedPlayer.status === 'away' ? 'away' : 'waiting';
                                updateData.chipsInPlay = rebuyAmount; // Ensure chips are updated
                            } else {
                                console.log(`❌ [Auto-Rebuy] Failed for ${populatedPlayer.user.username}, marking pending-rebuy`);
                                updateData.status = 'pending-rebuy';
                            }
                        } catch (rebuyError) {
                            console.error(`❌ [Auto-Rebuy] Error for ${populatedPlayer.user.username}:`, rebuyError.message);
                            updateData.status = 'pending-rebuy';
                        }
                    } else {
                        // No auto-renew - mark for manual rebuy
                        updateData.status = 'pending-rebuy';
                        console.log(`⚠️ Human ${populatedPlayer.user.username} has insufficient chips (${populatedPlayer.chipsInPlay}), marked for rebuy`);
                    }
                } else if (populatedPlayer.status !== 'pending-rebuy') {
                    // ✅ CRITICAL FIX: Preserve 'away' status during table turnover
                    updateData.status = populatedPlayer.status === 'away' ? 'away' : 'waiting';
                }

                if (Object.keys(updateData).length > 0) {
                    await mongoHelper.updateById(
                        mongoHelper.COLLECTIONS.PLAYERS,
                        populatedPlayer._id,
                        updateData,
                        mongoHelper.MODELS.PLAYER
                    );
                }

                await handleArchivedTable(table, 'update', {
                    action: 'round_completed',
                    userId: populatedPlayer.user._id,
                    roundsPlayed: 1,
                    netProfit: netProfit,
                });

                newGameStateData.actionHistory.push(
                    { event: `Player Update - ${populatedPlayer.user.username}:` },
                    { event: `  Previous Stack: ${previousChips}` },
                    { event: `  Starting Stack: ${startingChips}` },
                    { event: `  Net Profit: ${netProfit}` }
                );
            }
        }

        newGameStateData.actionHistory.push(
            { event: '' },
            { event: 'Chip Summary for New Round:' },
            ...playerChipsLog.map(log => ({
                event: `${log.username} - Stack: ${log.previousChips}`,
            })),
            { event: '' }
        );

        const updatedGameRounds = table.gameRoundsCompleted + 1;

        const playerIds = table.currentPlayers.map(p => p._id || p);

        const activePlayersResult = await mongoHelper.filter(mongoHelper.COLLECTIONS.PLAYERS, {
            _id: { $in: playerIds },
            status: { $in: ['waiting', 'pending-rebuy'] },
        });

        let newDealerPosition = table.dealerPosition;
        if (activePlayersResult.success && activePlayersResult.data.length > 0) {
            const activePlayers = [];
            for (const player of activePlayersResult.data) {
                const playerWithUser = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.PLAYERS, player._id, [
                    {
                        path: 'user',
                        collection: mongoHelper.COLLECTIONS.USERS,
                        select: 'username',
                    },
                ]);
                if (playerWithUser.success) {
                    activePlayers.push(playerWithUser.data);
                }
            }

            activePlayers.sort((a, b) => a.seatPosition - b.seatPosition);

            if (activePlayers.length > 0) {
                // ✅ FIX: Find current dealer in active players
                const currentDealerIndex = activePlayers.findIndex(p => p.seatPosition === table.dealerPosition);
                
                // ✅ FIX: If current dealer not found OR only 1 player, use first player
                if (currentDealerIndex === -1 || activePlayers.length === 1) {
                    newDealerPosition = activePlayers[0].seatPosition;
                    console.log(`✅ [Dealer] Reset to first active player: Seat ${newDealerPosition}`);
                } else {
                    // ✅ FIX: Rotate to next active player
                    const nextDealerIndex = (currentDealerIndex + 1) % activePlayers.length;
                    newDealerPosition = activePlayers[nextDealerIndex].seatPosition;
                    console.log(`✅ [Dealer] Rotated from Seat ${table.dealerPosition} to Seat ${newDealerPosition}`);
                }

                const newDealer = activePlayers.find(p => p.seatPosition === newDealerPosition);
                const dealerUsername = newDealer?.user ? newDealer.user.username : `Player in Seat ${newDealerPosition}`;

                newGameStateData.actionHistory.push({
                    event: `Dealer button moved to ${dealerUsername} (Seat ${newDealerPosition})`,
                });
            }
        }

        if (gameState && gameState._id) {
            const deleteResult = await mongoHelper.deleteById(mongoHelper.COLLECTIONS.GAME_STATES, gameState._id);
            if (deleteResult.success) {
                console.log(`✅ [Game State] Old game state deleted successfully`);
            }
        }

        console.log(`🎮 [handleTableTurnover] Creating new game state...`);
        const newGameStateResult = await mongoHelper.create(
            mongoHelper.COLLECTIONS.GAME_STATES,
            newGameStateData,
            mongoHelper.MODELS.GAME_STATE
        );

        if (!newGameStateResult.success) {
            console.error(`❌ [handleTableTurnover] Failed to create new game state`);
            throw new Error('Failed to create new game state');
        }
        console.log(`✅ [handleTableTurnover] New game state created: ${newGameStateResult.data._id}`);

        console.log(`💾 [handleTableTurnover] Updating table with new game state...`);
        await mongoHelper.updateById(
            mongoHelper.COLLECTIONS.TABLES,
            table._id,
            {
                gameState: newGameStateResult.data._id,
                dealerPosition: newDealerPosition,
                gameRoundsCompleted: updatedGameRounds,
                handsByPlayer: (() => {
                    // Convert plain object from DB to Map
                    const handsByPlayer = table.handsByPlayer instanceof Map 
                        ? table.handsByPlayer 
                        : new Map(Object.entries(table.handsByPlayer || {}));
                    
                    for (const player of table.currentPlayers) {
                        if (!['folded', 'waiting', 'pending-rebuy'].includes(player.status)) {
                            const playerId = player._id.toString();
                            const currentHands = handsByPlayer.get(playerId) || 0;
                            handsByPlayer.set(playerId, currentHands + 1);
                            console.log(`📊 [Hands] ${player.user?.username}: ${currentHands} -> ${currentHands + 1}`);
                        }
                    }
                    // Convert Map back to plain object for MongoDB
                    return Object.fromEntries(handsByPlayer);
                })()
            },
            mongoHelper.MODELS.TABLE
        );

        // ✅ CRITICAL: Reset ALL game state flags after turnover
        gameStates[roomId].turnoverComplete = true;
        gameStates[roomId].isGameStarting = false;
        gameStates[roomId].isProcessingTurnover = false;
        gameStates[roomId].isProcessingShowdown = false;
        gameStates[roomId].needsTurnover = false;
        gameStates[roomId].turnoverData = null;

        // Clear any processing locks
        if (gameStates[roomId].processingAction) {
            delete gameStates[roomId].processingAction;
        }

        console.log(`✅ [handleTableTurnover] Table turnover completed successfully.`);
        console.log(`📊 [handleTableTurnover] Final state:`, {
            newDealerPosition,
            updatedGameRounds,
            newGameStateId: newGameStateResult.data._id
        });

        console.log(`🔄 [handleTableTurnover] Fetching fresh table data...`);
        const freshTable = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.TABLES, table._id, [
            {
                path: 'currentPlayers',
                collection: mongoHelper.COLLECTIONS.PLAYERS,
            },
        ]);

        if (freshTable.success) {
            const readyPlayersCount = freshTable.data.currentPlayers.filter(player => player.status === 'waiting').length;
            const pendingRebuyCount = freshTable.data.currentPlayers.filter(player => player.status === 'pending-rebuy').length;

            // ✅ CRITICAL FIX: Check if players have minimum chips required
            const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, freshTable.data.tableTypeId._id || freshTable.data.tableTypeId);
            const minChipsRequired = tableTypeResult.success && tableTypeResult.data ? tableTypeResult.data.bigBlind : 20;

            const playersWithSufficientChips = freshTable.data.currentPlayers.filter(
                player => player.status === 'waiting' && player.chipsInPlay >= minChipsRequired
            ).length;

            // ✅ DEBUG: Log each player's status and chips
            console.log(`🔍 [handleTableTurnover] Player Status Debug:`);
            freshTable.data.currentPlayers.forEach(player => {
                console.log(`  - ${player.user?.username || 'Unknown'}: Status=${player.status}, Chips=${player.chipsInPlay}, IsBot=${player.isBot}`);
            });

            console.log(`👥 [handleTableTurnover] Players - Ready: ${readyPlayersCount}, Sufficient Chips: ${playersWithSufficientChips}, Pending Rebuy: ${pendingRebuyCount}, Min Required: ${minChipsRequired}`);

            if (playersWithSufficientChips >= 2 && pendingRebuyCount === 0) {
                console.log(`🎮 [handleTableTurnover] Sufficient players (${playersWithSufficientChips}), emitting newRoundStarting`);
                io.to(roomId).emit('newRoundStarting', {
                    message: 'A new round is starting. Get ready!',
                    status: true,
                });

                // ✅ CRITICAL: Check if game is already starting to prevent duplicate starts
                if (gameStates[roomId]?.isGameStarting) {
                    console.log(`⚠️ [handleTableTurnover] Game already starting, skipping auto-start`);
                    return { message: 'Game already starting', status: true };
                }

                // ✅ FIX: Find first HUMAN player with valid socketId (not bot)
                const humanPlayers = freshTable.data.currentPlayers
                    .filter(p => !p.isBot && p.socketId && !p.socketId.startsWith('bot'))
                    .sort((a, b) => a.seatPosition - b.seatPosition);

                const firstHuman = humanPlayers[0];
                console.log(firstHuman , "----------------------------------------------------------------------")
                if (firstHuman) {
                    console.log(`📢 [handleTableTurnover] Emitting callStartGame to human player: ${firstHuman.user?.username}`);
                    io.to(firstHuman.socketId).emit('callStartGame', {
                        message: 'Please call startGame now!',
                        status: true,
                    });
                }

                // ✅ Fallback: Auto-start after 3 seconds if client doesn't respond
                setTimeout(async () => {
                    try {
                        // ✅ Get fresh table and game state from database
                        const currentTable = await getTableById(table._id);
                        if (!currentTable) {
                            console.log(`⚠️ [handleTableTurnover] Table not found for auto-start`);
                            return;
                        }

                        // Check database game state, not in-memory
                        let currentGameState = null;
                        if (currentTable.gameState) {
                            const gameStateResult = await mongoHelper.findById(
                                mongoHelper.COLLECTIONS.GAME_STATES,
                                currentTable.gameState._id || currentTable.gameState
                            );
                            if (gameStateResult.success) {
                                currentGameState = gameStateResult.data;
                            }
                        }

                        const isAlreadyStarting = gameStates[roomId]?.isGameStarting;
                        const isGameOngoing = currentGameState?.status === 'gameOngoing';

                        console.log(`⏰ [handleTableTurnover] Auto-start check: starting=${isAlreadyStarting}, ongoing=${isGameOngoing}`);

                        if (!isAlreadyStarting && !isGameOngoing) {
                            console.log(`⏰ [handleTableTurnover] Auto-starting game (client didn't respond)`);
                            const gameService = require('./game.service');
                                                        const socketModule = require('../ws/socket.js'); if (socketModule.executeStartGameLogic) { await socketModule.executeStartGameLogic(io, table, null, null); } else { await gameService.startGame(table._id, gameStates, io); }
                        } else {
                            console.log(`⚠️ [handleTableTurnover] Skipping auto-start: isStarting=${isAlreadyStarting}, isOngoing=${isGameOngoing}`);
                        }
                    } catch (err) {
                        console.error(`❌ [handleTableTurnover] Auto-start failed:`, err.message);
                    }
                }, 3000);
            } else {
                console.log(`⚠️ [handleTableTurnover] Insufficient players with chips (${playersWithSufficientChips}/${readyPlayersCount}) or pending rebuys (${pendingRebuyCount})`);

                // ✅ Notify players about insufficient chips
                if (playersWithSufficientChips < 2) {
                    io.to(roomId).emit('waitingForPlayers', {
                        message: `Waiting for players with sufficient chips (minimum ${minChipsRequired}). Current: ${playersWithSufficientChips}/2`,
                        status: true,
                        data: {
                            requiredPlayers: 2,
                            currentPlayers: playersWithSufficientChips,
                            minChipsRequired
                        }
                    });
                }

                // ✅ CRITICAL: Notify players with pending-rebuy status
                if (pendingRebuyCount > 0) {
                    const pendingRebuyPlayers = freshTable.data.currentPlayers.filter(p => p.status === 'pending-rebuy');
                    for (const player of pendingRebuyPlayers) {
                        if (player.socketId && !player.socketId.startsWith('bot')) {
                            io.to(player.socketId).emit('rebuyRequired', {
                                message: `You need to rebuy to continue playing (minimum ${minChipsRequired} chips)`,
                                status: true,
                                data: {
                                    currentChips: player.chipsInPlay,
                                    minChipsRequired,
                                    playerId: player._id
                                }
                            });
                            console.log(`📢 [handleTableTurnover] Sent rebuy notification to ${player.user?.username}`);
                        }
                    }
                }

                if (gameStates[roomId]) {
                    gameStates[roomId].isProcessingTurnover = false;
                }
            }
        }

        console.log(`✅ [handleTableTurnover] EXIT - Turnover completed successfully for room: ${roomId}`);
        return {
            message: 'Table turned over for the next round',
            status: true,
        };
    } catch (error) {
        if (gameStates[roomId]) {
            gameStates[roomId].isProcessingTurnover = false;
            gameStates[roomId].turnoverComplete = false;
        }
        console.error(`❌ [handleTableTurnover] Error during table turnover: ${error.message}`);
        console.error(`❌ [handleTableTurnover] Stack:`, error.stack);
        throw new Error(`Table turnover error: ${error.message}`);
    } finally {
        if (gameStates[roomId]) gameStates[roomId].isProcessingTurnover = false;
        console.log(`🔓 [handleTableTurnover] Lock released for room: ${roomId}`);
    }
};

const createTable = async (playerCount, tableTypeId, tableBlockchainId, tableAddress, isPreCreated = false, status = 'in-use') => {
    // console.log('🚀 ~ createTable ~ tableBlockchainId:', tableBlockchainId);
    try {
        const tableData = {
            tableTypeId,
            maxPlayers: playerCount,
            blockchainAddress: tableAddress,
            tableBlockchainId,
            currentPlayers: [],
            gameRoundsCompleted: 0,
            dealerPosition: null,
            currentTurnPosition: null,
            smallBlindPosition: null,
            bigBlindPosition: null,
            isPreCreated,
            status,
        };
        console.log('🚀 ~ createTable ~ tableData:', tableData);
        const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TABLES, tableData, mongoHelper.MODELS.TABLE);
        console.log('🚀 ~ createTable ~ createResult:', createResult);
        if (!createResult.success) {
            throw new Error(createResult.error);
        }

        const newTable = createResult.data;
        await handleArchivedTable(newTable, 'create');
        return newTable;
    } catch (error) {
        throw new Error(error.message);
    }
};

const handleArchivedTable = async (table, action, actionData = {}) => {
    try {
        switch (action) {
            case 'create': {
                const archivedTableData = {
                    originalTableId: table._id,
                    tableTypeId: table.tableTypeId,
                    status: 'active',
                    participants: [],
                    gameLogs: [],
                    createdAt: new Date(),
                };

                const createResult = await mongoHelper.create(
                    mongoHelper.COLLECTIONS.ARCHIVED_TABLES,
                    archivedTableData,
                    mongoHelper.MODELS.ARCHIVED_TABLE
                );

                if (!createResult.success) {
                    throw new Error(createResult.error);
                }

                return createResult.data;
            }

            case 'archive': {
                const archivedTableResult = await mongoHelper.find(mongoHelper.COLLECTIONS.ARCHIVED_TABLES, {
                    originalTableId: table._id,
                });

                if (!archivedTableResult.success || !archivedTableResult.data || archivedTableResult.data.length === 0) {
                    throw new ApiError(httpStatus.NOT_FOUND, 'Archived table record not found');
                }

                const archivedTable = archivedTableResult.data[0];

                const updateData = {
                    status: 'archived',
                    endedAt: new Date(),
                    archivedReason: actionData.reason,
                    totalRounds: table.gameRoundsCompleted,
                };

                if (actionData.actionHistory && actionData.actionHistory.length > 0) {
                    updateData.gameLogs = actionData.actionHistory.map(item => {
                        if (item && typeof item === 'object' && 'event' in item) {
                            return item;
                        }

                        return { event: String(item) };
                    });

                    console.log(`Saved ${updateData.gameLogs.length} game logs to archived table`);
                } else {
                    console.log('No action history to save to archived table');
                    updateData.gameLogs = [];
                }

                const updateResult = await mongoHelper.updateById(
                    mongoHelper.COLLECTIONS.ARCHIVED_TABLES,
                    archivedTable._id,
                    updateData,
                    mongoHelper.MODELS.ARCHIVED_TABLE
                );

                if (!updateResult.success) {
                    throw new Error(updateResult.error);
                }

                return updateResult.data;
            }

            case 'update': {
                const archivedTableResult = await mongoHelper.find(mongoHelper.COLLECTIONS.ARCHIVED_TABLES, {
                    originalTableId: table._id,
                });

                if (!archivedTableResult.success || !archivedTableResult.data || archivedTableResult.data.length === 0) {
                    return null;
                }

                const archivedTable = archivedTableResult.data[0];
                let updateData = {};

                switch (actionData.action) {
                    case 'player_joined':
                        if (!archivedTable.participants.some(p => p.userId.toString() === actionData.userId.toString())) {
                            const updatedParticipants = [
                                ...archivedTable.participants,
                                {
                                    userId: actionData.userId,
                                    joinedAt: new Date(),
                                    totalHandsPlayed: 0,
                                    handsWon: 0,
                                    totalProfit: 0,
                                },
                            ];
                            updateData.participants = updatedParticipants;
                        }
                        break;

                    case 'player_left':
                        const participantIndex = archivedTable.participants.findIndex(
                            p => p.userId.toString() === actionData.userId.toString()
                        );
                        if (participantIndex !== -1) {
                            const updatedParticipants = [...archivedTable.participants];
                            updatedParticipants[participantIndex].leftAt = new Date();
                            updateData.participants = updatedParticipants;
                        }
                        break;

                    case 'hand_won':
                        const winnerIndex = archivedTable.participants.findIndex(
                            p => p.userId.toString() === actionData.userId.toString()
                        );
                        if (winnerIndex !== -1) {
                            const updatedParticipants = [...archivedTable.participants];
                            updatedParticipants[winnerIndex].handsWon++;
                            updatedParticipants[winnerIndex].totalProfit += actionData.profit;
                            updateData.participants = updatedParticipants;
                        }
                        break;

                    case 'round_completed':
                        // console.log(archivedTable.participants, 'archivedTable.participants');
                        // console.log(actionData, 'actionData');
                        const playerIndex = archivedTable.participants.findIndex(
                            p => p.userId.toString() === actionData.userId.toString()
                        );
                        if (playerIndex !== -1) {
                            const updatedParticipants = [...archivedTable.participants];
                            updatedParticipants[playerIndex].totalHandsPlayed += actionData.roundsPlayed;
                            updatedParticipants[playerIndex].totalProfit += actionData.netProfit;
                            updateData.participants = updatedParticipants;
                        }
                        break;
                }

                if (Object.keys(updateData).length > 0) {
                    const updateResult = await mongoHelper.updateById(
                        mongoHelper.COLLECTIONS.ARCHIVED_TABLES,
                        archivedTable._id,
                        updateData,
                        mongoHelper.MODELS.ARCHIVED_TABLE
                    );

                    if (!updateResult.success) {
                        throw new Error(updateResult.error);
                    }

                    return updateResult.data;
                }

                return archivedTable;
            }
        }
    } catch (error) {
        console.error('Error handling archived table:', error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
    }
};

const findTableOrCreateThroughBlockchain = async (playerCount, tableTypeId, chipsInPlay, userAddress, userId) => {
    try {
        console.log(`🔍 Finding/Creating table for user: ${userAddress}, chips: ${chipsInPlay}`);

        // First, try to find existing table with vacancies
        let table = await findTableWithVacancies(playerCount, tableTypeId, userId);
        if (table) {
            console.log(`✅ Found existing table: ${table._id}, blockchain ID: ${table.tableBlockchainId}`);

            // Get table balance before transfer
            // const balanceBefore = await getTableBalance(table.blockchainAddress);
            // console.log(`💰 Table balance before transfer: ${balanceBefore} USDT`);

            // Table exists, transfer funds from user's pool to table
            const transferResult = await transferFromPoolToTable(userAddress, table.blockchainAddress, chipsInPlay);

            if (!transferResult.success) {
                console.error('❌ Failed to transfer funds to existing table:', transferResult.error);
                throw new Error(`Fund transfer failed: ${transferResult.error}`);
            }

            // // Get table balance after transfer
            // const balanceAfter = await getTableBalance(table.blockchainAddress);
            // console.log(
            //   `🎯 Table balance after transfer: ${balanceAfter} USDT (increased by ${balanceAfter - balanceBefore} USDT)`
            // );

            return {
                table,
                isBlockchainEnabled: true,
                blockchainInfo: {},
                tableData: table,
                wasCreated: false,
                message: 'Joined existing table with funds transferred',
            };
        }

        // No existing table found, create new one
        console.log('🆕 No existing table found, creating new table...');

        // Create table on blockchain first
        const createResult = await createTableOnBlockchain(userAddress, rakePercent, chipsInPlay);

        if (!createResult.success) {
            console.error('❌ Failed to create table:', createResult.error);
            throw new Error(`Table creation failed: ${createResult.error}`);
        }

        console.log('🎯 Successfully created table on blockchain:', {
            tableId: createResult.tableId,
            tableAddress: createResult.tableAddress,
        });

        // Save new table to database
        const newTable = await createTable(playerCount, tableTypeId, createResult.tableId, createResult.tableAddress);

        console.log('💾 Successfully saved table to database');
        console.log('💰 Transferring creator funds to new table...');
        const transferResult = await transferFromPoolToTable(userAddress, createResult.tableAddress, chipsInPlay);

        if (!transferResult.success) {
            console.error('❌ Failed to transfer creator funds to new table:', transferResult.error);
            throw new Error(`Creator fund transfer failed: ${transferResult.error}`);
        }

        console.log('✅ Creator funds successfully transferred to new table');

        return {
            table: newTable,
            isBlockchainEnabled: true,
            blockchainInfo: {},
            tableData: newTable,
            wasCreated: true,
            message: 'Created new table with funds transferred',
        };
    } catch (error) {
        console.error('💥 Error in findTableOrCreateThroughBlockchain:', error);
        throw new Error(`Table operation failed: ${error.message}`);
    }
};

const findTableWithVacancies = async (playerCount, tableTypeId, userId = null) => {
    try {
        console.log(`🔍 [findTableWithVacancies] Looking for table - playerCount: ${playerCount}, tableTypeId: ${tableTypeId}, userId: ${userId}`);

        // Use table pool service to get available table
        const tablePoolService = require('./tablePool.service');
        const table = await tablePoolService.getAvailableTable(tableTypeId, playerCount, userId);

        if (!table) {
            console.log(`❌ [findTableWithVacancies] No suitable table found`);
            return null;
        }

        console.log(`✅ [findTableWithVacancies] Found suitable table ${table._id}`);

        // Populate currentPlayers data
        const populatedPlayers = [];
        for (const playerId of table.currentPlayers) {
            const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PLAYERS, playerId);
            if (playerResult.success && playerResult.data) {
                const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerResult.data.user);
                if (userResult.success) {
                    populatedPlayers.push({
                        ...playerResult.data,
                        user: { username: userResult.data.username },
                    });
                }
            }
        }

        // Trigger pool replenishment in background (non-blocking)
        tablePoolService.ensureTablePool(tableTypeId, playerCount).catch(err => {
            console.error('❌ [findTableWithVacancies] Error ensuring pool:', err.message);
        });

        return {
            ...table,
            currentPlayers: populatedPlayers,
        };
    } catch (error) {
        console.error(`❌ [findTableWithVacancies] Error:`, error.message);
        return null;
    }
};

const getTableById = async tableId => {
    try {
        const populateFields = [
            {
                path: 'currentPlayers',
                collection: mongoHelper.COLLECTIONS.PLAYERS,
                populate: {
                    path: 'user',
                    collection: mongoHelper.COLLECTIONS.USERS,
                    select: 'username',
                },
            },
            {
                path: 'gameState',
                collection: mongoHelper.COLLECTIONS.GAME_STATES,
            },
            {
                path: 'tableTypeId',
                collection: mongoHelper.COLLECTIONS.TABLE_TYPES,
            },
        ];

        const result = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.TABLES, tableId, populateFields);

        if (!result.success || !result.data) {
            throw new Error(result.error || 'Table not found');
        }

        // ✅ FIX: Ensure currentPlayers exists and is an array
        if (!result.data.currentPlayers || !Array.isArray(result.data.currentPlayers)) {
            console.error(`❌ [getTableById] Invalid currentPlayers data for table ${tableId}`);
            result.data.currentPlayers = [];
        }

        // **IMPROVED BOT HANDLING** - Make this consistent
        for (const player of result.data.currentPlayers) {
            if (typeof player.user === 'string' && player.user.startsWith('bot_')) {
                // Extract bot number for consistent naming
                const botNumber = player.user.split('_')[1];
                player.user = {
                    _id: player.user, // Keep the original bot_1 ID
                    username: `Bot${botNumber}`,
                    isBot: true,
                };
            } else if (
                !player.user ||
                (typeof player.user === 'object' && (!player.user._id || Object.keys(player.user).length === 0))
            ) {
                // Handle cases where user object is missing or empty
                // Check if this player has isBot flag or if user starts with 'bot_'
                if (player.isBot || (typeof player.user === 'string' && player.user.startsWith('bot_'))) {
                    const botNumber = player.isBot ? Math.floor(Math.random() * 1000) : player.user.split('_')[1];
                    player.user = {
                        _id: player.user || `bot_${botNumber}`,
                        username: `Bot${botNumber}`,
                        isBot: true,
                    };
                } else {
                    // For human players with missing user data, use fallback
                    const username = randomNames[Math.floor(Math.random() * randomNames.length)];
                    player.user = {
                        _id: player.user?._id || 'unknown',
                        username,
                        isBot: false,
                    };
                }
            }
            // If user is already properly populated (human player), leave it as is
        }

        return result.data;
    } catch (error) {
        throw new Error(error.message);
    }
};

const getTableByBlockChainId = async tableBlockchainId => {
    try {
        const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, { tableBlockchainId: tableBlockchainId });
        // console.log('🚀 ~ getTableByBlockChainId ~ result:', result);
        if (!result.success || !result.data) {
            return null;
        }

        return result.data[0]._id;
    } catch (error) {
        throw new Error(error.message);
    }
};

const findTableByPlayerId = async (userId, playerId, event = null) => {
    try {
        // Find existing player by userId and populate user data
        const playerByUserResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.PLAYERS, 'user', userId);

        let existingPlayer = null;
        if (playerByUserResult.success && playerByUserResult.data) {
            // Manually populate user data (Option 1 approach)
            const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerByUserResult.data.user);
            if (userResult.success && userResult.data) {
                existingPlayer = {
                    ...playerByUserResult.data,
                    user: {
                        username: userResult.data.username,
                        email: userResult.data.email,
                        walletAddress: userResult.data.walletAddress,
                        profilePic: userResult.data.profilePic,
                    },
                };
            }
        }

        if (existingPlayer) {
            await mongoHelper.deleteById(mongoHelper.COLLECTIONS.PLAYERS, existingPlayer._id);
            throw new Error('User is not part of any table. Please join a new table.');
        }

        // Find player by socketId
        const playerResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.PLAYERS, 'socketId', playerId);

        if (!playerResult.success || !playerResult.data) {
            return { status: 'alreadyRemoved' };
        }

        const player = playerResult.data;
        const tablesResult = await mongoHelper.filter(mongoHelper.COLLECTIONS.TABLES, {
            currentPlayers: { $in: [player._id] },
        });

        if (!tablesResult.success || !tablesResult.data.length) {
            // Player not associated with any table (already removed).
            return { status: 'not_found' };
        }

        // Manually populate the first matching table
        const table = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.TABLES, tablesResult.data[0]._id, [
            {
                path: 'currentPlayers',
                collection: mongoHelper.COLLECTIONS.PLAYERS,
                populate: {
                    path: 'user',
                    collection: mongoHelper.COLLECTIONS.USERS,
                    select: 'username',
                },
            },
            {
                path: 'gameState',
                collection: mongoHelper.COLLECTIONS.GAME_STATES,
            },
            {
                path: 'tableTypeId',
                collection: mongoHelper.COLLECTIONS.TABLE_TYPES,
            },
        ]);

        if (!table.success) {
            // Could not populate the matching table - treat as not found.
            return { status: 'not_found' };
        }

        for (const player of table.data.currentPlayers) {
            if (typeof player.user === 'string' && player.user.startsWith('bot_')) {
                // Bot player
                const botNumber = player.user.split('_')[1];
                player.user = {
                    _id: player.user,
                    username: `Bot${botNumber}`,
                    isBot: true,
                };
            } else if (typeof player.user === 'object' && Object.keys(player.user).length === 0) {
                // Empty user object - check if it's a bot
                if (player.isBot) {
                    const botNumber = Math.floor(Math.random() * 1000); // Generate random number for fallback
                    player.user = {
                        _id: `bot_${botNumber}`,
                        username: `Bot${botNumber}`,
                        isBot: true,
                    };
                } else {
                    // Human player with empty user object
                    const username = randomNames[Math.floor(Math.random() * randomNames.length)];
                    player.user = {
                        _id: player.user._id || 'unknown',
                        username,
                        isBot: false,
                    };
                }
            }
            // If user is already properly populated, leave it as is
        }

        return { status: 'removed', table: table.data, player: existingPlayer };
    } catch (error) {
        console.error('Error in findTableByPlayerId:', error);
        throw new ApiError(httpStatus.FORBIDDEN, error.message, true, error.stack);
    }
};

const clearTableWithOnlyBots = async (table, gameStates, io) => {
    const roomId = table._id.toString();
    console.log(`🤖 [clearTableWithOnlyBots] Clearing table ${roomId} with only bots`);
    
    try {
        // Delete all bot players
        for (const player of table.currentPlayers) {
            if (player.isBot) {
                await mongoHelper.deleteById(mongoHelper.COLLECTIONS.PLAYERS, player._id);
            }
        }
        
        // Delete game state
        if (table.gameState) {
            await mongoHelper.deleteById(mongoHelper.COLLECTIONS.GAME_STATES, table.gameState._id || table.gameState);
        }
        
        // Clear table
        await mongoHelper.updateById(
            mongoHelper.COLLECTIONS.TABLES,
            table._id,
            {
                currentPlayers: [],
                isCleared: true,
                gameRoundsCompleted: 0,
                dealerPosition: null,
                currentTurnPosition: null,
                smallBlindPosition: null,
                bigBlindPosition: null,
                gameState: null,
                status: 'available'
            },
            mongoHelper.MODELS.TABLE
        );
        
        // Clear in-memory state
        if (gameStates[roomId]) {
            delete gameStates[roomId];
        }
        
        // Remove bot from botManager
        const botManagerModule = require('../ws/socket');
        if (botManagerModule?.botManager?.has(roomId)) {
            const bot = botManagerModule.botManager.get(roomId);
            if (bot?.actionTimer) clearTimeout(bot.actionTimer);
            botManagerModule.botManager.remove(roomId);
        }
        
        io.to(roomId).emit('tableCleared', {
            message: 'Table cleared - only bots remaining',
            status: true,
        });
        
        console.log(`✅ [clearTableWithOnlyBots] Table ${roomId} cleared successfully`);
    } catch (error) {
        console.error(`❌ [clearTableWithOnlyBots] Error:`, error.message);
    }
};

const addUserToTable = async (
    tableId,
    userId,
    socketId,
    chipsInPlay,
    autoRenew = false,
    maxBuy = false,
    io,
    isBot = false
) => {
    console.log(`👥 [addUserToTable] ENTRY - TableId: ${tableId}, UserId: ${userId}, Chips: ${chipsInPlay}, IsBot: ${isBot}`);
    
    // ✅ CRITICAL: Use queue to prevent race conditions
    return await tableJoinQueue.enqueue(tableId, async () => {
        return await _addUserToTableInternal(tableId, userId, socketId, chipsInPlay, autoRenew, maxBuy, io, isBot);
    });
};

const _addUserToTableInternal = async (
    tableId,
    userId,
    socketId,
    chipsInPlay,
    autoRenew = false,
    maxBuy = false,
    io,
    isBot = false
) => {
    console.log(`👥 [_addUserToTableInternal] Processing join - TableId: ${tableId}, UserId: ${userId}`);
    try {
        // console.log('------------------------------------');
        // console.log(tableId, userId, chipsInPlay, autoRenew, maxBuy, isBot);
        // console.log('------------------------------------');
        const tableResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.TABLES, tableId, [
            {
                path: 'currentPlayers',
                collection: mongoHelper.COLLECTIONS.PLAYERS,
                populate: {
                    path: 'user',
                    collection: mongoHelper.COLLECTIONS.USERS,
                    select: 'username',
                },
            },
        ]);
        console.log(`📊 [_addUserToTableInternal] Table found:`, { currentPlayers: tableResult.data?.currentPlayers?.length, maxPlayers: tableResult.data?.maxPlayers });
        if (!tableResult.success || !tableResult.data) {
            console.error(`❌ [_addUserToTableInternal] Table not found: ${tableId}`);
            throw new Error('Table not found');
        }

        const table = tableResult.data;

        // ✅ FIXED: Safe check for user already in table
        const userAlreadyInTable = table.currentPlayers.some(player => {
            // Check if player.user exists and has _id
            if (!player.user || !player.user._id) {
                return false;
            }
            return player.user._id.toString() === userId;
        });

        if (userAlreadyInTable) {
            console.log(`⚠️ [_addUserToTableInternal] User already in table: ${userId}`);
            return { error: true, message: 'User is already in the table' };
        }

        let assignedSeatPosition = null;
        for (let i = 1; i <= table.maxPlayers; i++) {
            if (!table.currentPlayers.some(player => player.seatPosition === i)) {
                assignedSeatPosition = i;
                break;
            }
        }

        if (!assignedSeatPosition) {
            assignedSeatPosition = table.currentPlayers.length + 1;
        }

        const playerData = {
            balance: 0,
            user: userId,
            seatPosition: assignedSeatPosition,
            status: 'waiting',
            socketId,
            hand: [],
            chipsInPlay,
            autoRenew,
            maxBuy,
            isBot: isBot || false,
        };

        console.log(`👤 [_addUserToTableInternal] Creating player with seat position: ${assignedSeatPosition}`);
        const playerCreateResult = await mongoHelper.create(
            mongoHelper.COLLECTIONS.PLAYERS,
            playerData,
            mongoHelper.MODELS.PLAYER
        );

        if (!playerCreateResult.success) {
            console.error(`❌ [_addUserToTableInternal] Failed to create player`);
            throw new Error('Failed to create player');
        }
        console.log(`✅ [_addUserToTableInternal] Player created: ${playerCreateResult.data._id}`);;

        const player = playerCreateResult.data;
        
        // ✅ Initialize player for tier progression
        if (!isBot) {
            try {
                const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
                if (userResult.success && userResult.data) {
                    await reputationService.initializePlayerForTier(userResult.data);
                }
            } catch (initError) {
                console.error(`⚠️ [_addUserToTableInternal] Failed to initialize tier:`, initError.message);
            }
        }
        
        try {
            await updateUserHandStats(userId, {
                isDeposit: true,
                amount: chipsInPlay,
            });
            // console.log(`Recorded deposit of ${chipsInPlay} for user ${userId}`);
        } catch (statError) {
            console.error(`Failed to record deposit stat: ${statError.message}`);
        }

        // Update table with new player
        const updatedPlayers = [...table.currentPlayers.map(p => p._id), player._id];
        await mongoHelper.updateById(
            mongoHelper.COLLECTIONS.TABLES,
            tableId,
            { currentPlayers: updatedPlayers },
            mongoHelper.MODELS.TABLE
        );

        // ✅ FIXED: Check if this was the first player (making the count 1)
        if (updatedPlayers.length === 1) {
            console.log('🎮 Creating game state for first player...');

            const gameStateData = {
                tableId: table._id,
                players: [],
                boardCards: [],
                currentBet: 0,
                pot: 0,
                currentRound: 0,
                actionHistory: [],
                status: 'waitingForPlayers',
            };

            const gameStateResult = await mongoHelper.create(
                mongoHelper.COLLECTIONS.GAME_STATES,
                gameStateData,
                mongoHelper.MODELS.GAME_STATE
            );

            if (gameStateResult.success) {
                console.log('🎮 Game state created successfully:', gameStateResult.data._id);

                // Update table with the newly created game state
                await mongoHelper.updateById(
                    mongoHelper.COLLECTIONS.TABLES,
                    tableId,
                    { gameState: gameStateResult.data._id },
                    mongoHelper.MODELS.TABLE
                );

                // Emit table creation to admin
                io.to('admin:activeTablesList').emit('tableCreated', {
                    tableId: table._id,
                    maxPlayers: table.maxPlayers,
                    currentPlayers: 1,
                    tableTypeId: table.tableTypeId,
                    gameState: gameStateResult.data._id,
                    createdAt: table.createdAt,
                });
            } else {
                console.error('🎮 Failed to create game state:', gameStateResult.error);
                throw new Error('Failed to create game state');
            }
        } else {
            // Subsequent players - emit table update
            io.to('admin:activeTablesList').emit('tableUpdated', {
                tableId: table._id,
                currentPlayers: updatedPlayers.length,
                gameState: table.gameState,
                lastUpdate: new Date(),
            });
        }

        // Get the updated table with all populated data
        console.log(`🔄 [_addUserToTableInternal] Fetching updated table data...`);
        const updatedTable = await getTableById(tableId);
        await createInitialUserStats(userId);
        await handleArchivedTable(updatedTable, 'update', {
            action: 'player_joined',
            userId: userId,
        });

        console.log(`✅ [_addUserToTableInternal] EXIT - User added successfully to table: ${tableId}`);
        return { error: false, tableData: updatedTable };
    } catch (error) {
        console.error(`❌ [_addUserToTableInternal] Error:`, error);
        console.error(`❌ [_addUserToTableInternal] Stack:`, error.stack);
        throw new Error(error.message);
    }
};

const removePlayerFromTable = async (tableId, socketId, gameStates, io) => {
    const roomId = tableId.toString();
    console.log(`🚪 [removePlayerFromTable] ENTRY - Room: ${roomId}, SocketId: ${socketId}`);
    try {
        // Ensure in-memory slot exists and serialize removal
        await gameStateManager.ensureGameState(roomId);
        console.log(`🔒 [removePlayerFromTable] Lock acquired for room: ${roomId}`);
        return await gameStateManager.lock(roomId, async () => {
            const tableResult = await mongoHelper.findByIdWithPopulate(
                mongoHelper.COLLECTIONS.TABLES,
                tableId,
                [
                    {
                        path: 'currentPlayers',
                        collection: mongoHelper.COLLECTIONS.PLAYERS,
                        populate: {
                            path: 'user',
                            collection: mongoHelper.COLLECTIONS.USERS,
                            select: 'username',
                        },
                    },
                ]
            );

            if (!tableResult.success || !tableResult.data) {
                return { error: true, message: 'Table not found' };
            }

            const table = tableResult.data;
            const playerToRemove = table.currentPlayers.find(p => p.socketId === socketId);
            console.log(`👤 [removePlayerFromTable] Player to remove:`, { username: playerToRemove?.user?.username, isBot: playerToRemove?.isBot });

            if (!playerToRemove) {
                console.warn(`⚠️ [removePlayerFromTable] Player with socketId ${socketId} not found on table ${tableId}`);
                return { error: true, message: 'Player not found in table' };
            }

            // Skip removal for bots that are already handled
            if (playerToRemove.socketId && playerToRemove.socketId.startsWith('bot')) {
                console.warn(`⚠️ [removePlayerFromTable] Bot player with socketId ${socketId}, skipping removal`);
                return { success: true, message: 'Skipping bot player removal' };
            }

            // Check if game is ongoing and player is in active hand
            const gameState = gameStates[roomId]?.gameState;
            const isGameOngoing = gameState && gameState.status === 'gameOngoing';
            const isPlayerInActiveHand = !['folded', 'waiting', 'pending-rebuy', 'left'].includes(playerToRemove.status);

            // ✅ CRITICAL: Check if this player was the current turn player
            const wasCurrentTurnPlayer = gameStates[roomId]?.currentPlayer === playerToRemove._id.toString() ||
                gameStates[roomId]?.currentTurnPlayer === playerToRemove._id.toString();

            console.log(`🎮 [removePlayerFromTable] Game state:`, {
                isGameOngoing,
                isPlayerInActiveHand,
                playerStatus: playerToRemove.status,
                wasCurrentTurnPlayer
            });

            // ✅ CRITICAL: Store this info for handlePostLeaveState AND clear current player to prevent duplicate turns
            if (wasCurrentTurnPlayer) {
                gameStates[roomId].leavingPlayerWasCurrentTurn = true;
                // Clear current player immediately to prevent duplicate turn processing
                gameStates[roomId].currentPlayer = null;
                gameStates[roomId].currentTurnPlayer = null;
                gameStates[roomId].currentPlayerInTurn = null;
                console.log(`🔒 [removePlayerFromTable] Cleared current player to prevent duplicate turns`);
            }

            // If player is in an active hand, mark them as folded first
            if (isGameOngoing && isPlayerInActiveHand) {
                console.log(`🃏 [removePlayerFromTable] Marking ${playerToRemove.user.username} as folded before removal`);
                await mongoHelper.updateById(
                    mongoHelper.COLLECTIONS.PLAYERS,
                    playerToRemove._id,
                    { status: 'folded' },
                    mongoHelper.MODELS.PLAYER
                );

                // Update the player object for further processing
                playerToRemove.status = 'folded';
            }

            // Remove player from the table
            const remainingPlayers = table.currentPlayers.filter(p => p._id.toString() !== playerToRemove._id.toString());
            await mongoHelper.updateById(
                mongoHelper.COLLECTIONS.TABLES,
                tableId,
                { currentPlayers: remainingPlayers.map(p => p._id) },
                mongoHelper.MODELS.TABLE
            );

            // ✅ CRITICAL: Auto-bring back away players if only 2 players remain
            const awayPlayers = remainingPlayers.filter(p => p.isAway && !p.isBot);
            if (remainingPlayers.length === 2 && awayPlayers.length > 0) {
                console.log(`⚠️ [removePlayerFromTable] Only 2 players remain, bringing back ${awayPlayers.length} away player(s)`);
                
                for (const awayPlayer of awayPlayers) {
                    await mongoHelper.updateById(
                        mongoHelper.COLLECTIONS.PLAYERS,
                        awayPlayer._id,
                        { isAway: false, awayRoundsCount: 0 },
                        mongoHelper.MODELS.PLAYER
                    );
                    
                    io.to(roomId).emit('backSet', {
                        message: `${awayPlayer.user?.username} is back (auto-returned due to low player count)`,
                        status: true,
                        data: { 
                            playerId: awayPlayer._id, 
                            username: awayPlayer.user?.username,
                            canOthersPutAway: false // Can't go away with only 2 players
                        },
                    });
                    
                    console.log(`✅ [removePlayerFromTable] Auto-returned ${awayPlayer.user?.username} from away status`);
                }
            }

            // ? CRITICAL: Process withdrawal for player's remaining chips (skip bots)
            if (playerToRemove.chipsInPlay > 0 && !playerToRemove.isBot) {
                console.log(`?? [removePlayerFromTable] Processing withdrawal for ${playerToRemove.user.username}: ${playerToRemove.chipsInPlay} chips`);
                
                try {
                    const fullUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerToRemove.user._id);
                    if (fullUserResult.success && fullUserResult.data) {
                        await blockchainService.queueWithdrawal(
                            fullUserResult.data._id,
                            table._id,
                            table.tableBlockchainId,
                            playerToRemove.chipsInPlay,
                            fullUserResult.data.walletAddress,
                            fullUserResult.data.email,
                            fullUserResult.data.username
                        );

                        io.to(socketId).emit('withdrawalQueued', {
                            message: `Your withdrawal of ${playerToRemove.chipsInPlay} chips has been queued`,
                            status: true,
                            data: { 
                                amount: playerToRemove.chipsInPlay,
                                walletAddress: fullUserResult.data.walletAddress 
                            },
                        });

                        console.log(`? [removePlayerFromTable] Withdrawal queued for ${fullUserResult.data.username}`);
                    }
                } catch (withdrawalErr) {
                    console.error(`? [removePlayerFromTable] Withdrawal failed for ${playerToRemove.user.username}:`, withdrawalErr.message);
                    io.to(socketId).emit('withdrawalFailed', {
                        message: 'Failed to process withdrawal. Please contact support.',
                        status: false,
                        data: { amount: playerToRemove.chipsInPlay }
                    });
                }
            }

            // Update player’s status and stats
            await mongoHelper.deleteById(
                mongoHelper.COLLECTIONS.PLAYERS,
                playerToRemove._id
            );
            console.log(`🗑️ [removePlayerFromTable] Deleted player record for ${playerToRemove.user.username}`);

            try {
                await updateUserHandStats(playerToRemove.user._id, {
                    isWin: false,
                    amount: 0,
                    potSize: gameStates[roomId]?.pot || 0,
                    reason: 'left_game',
                });
            } catch (statErr) {
                console.warn('Could not update hand stats on leave:', statErr.message);
            }

            // If table empty → delete table OR release to pool
            if (remainingPlayers.length === 0) {
                console.log(`🗑️ [removePlayerFromTable] Table empty: ${tableId}`);

                // Check if this is a pre-created table
                if (table.isPreCreated) {
                    console.log(`♻️ [removePlayerFromTable] Releasing pre-created table back to pool`);

                    // Release table back to pool (non-blocking)
                    const tablePoolService = require('./tablePool.service');
                    tablePoolService.releaseTable(tableId).catch(err => {
                        console.error('❌ [removePlayerFromTable] Error releasing table:', err.message);
                    });

                    io.to(roomId).emit('tableClosed', {
                        message: 'All players left — table returned to pool.',
                        status: true,
                    });
                } else {
                    // Delete non-pre-created tables
                    console.log(`🗑️ [removePlayerFromTable] Deleting non-pre-created table`);
                    await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TABLES, tableId);
                    io.to(roomId).emit('tableClosed', {
                        message: 'All players left — table closed.',
                        status: true,
                    });
                }

                if (gameStates[roomId]) delete gameStates[roomId];
                console.log(`✅ [removePlayerFromTable] EXIT - Table handled`);
                return { success: true, tableDeleted: !table.isPreCreated };
            }

            // Update in-memory state
            if (gameStates[roomId]) {
                delete gameStates[roomId]?.playerBets?.[socketId];
                delete gameStates[roomId]?.dealtCards?.[socketId];
                delete gameStates[roomId]?.totalContributions?.[socketId];

                // ✅ CRITICAL: Clear current player if it was the leaving player (already done above if wasCurrentTurnPlayer)
                // This is a safety check in case the above condition wasn't met
                if (gameStates[roomId].currentPlayer === playerToRemove._id.toString()) {
                    gameStates[roomId].currentPlayer = null;
                }
                if (gameStates[roomId].currentTurnPlayer === playerToRemove._id.toString()) {
                    gameStates[roomId].currentTurnPlayer = null;
                }
            }

            // Broadcast removal
            io.to(roomId).emit('playerLeft', {
                message: `${playerToRemove.user.username} left the room.`,
                status: true,
                data: await getTableById(tableId),
            });

            // ✅ Check if only bots remain after player removal
            const humanPlayers = remainingPlayers.filter(p => !p.isBot);
            if (humanPlayers.length === 0 && remainingPlayers.length > 0) {
                console.log(`🤖 [removePlayerFromTable] Only bots remain, clearing table immediately`);
                await clearTableWithOnlyBots(table, gameStates, io);
                return { success: true, tableCleared: true };
            }

            // Handle next-turn logic ONLY if game is ongoing
            if (isGameOngoing) {
                console.log(`🔄 [removePlayerFromTable] Game ongoing, handling post-leave state...`);
                await handlePostLeaveState(tableId, gameStates, io);
            } else {
                console.log(`ℹ️ [removePlayerFromTable] Game not ongoing, no turn handling needed`);
            }

            console.log(`✅ [removePlayerFromTable] EXIT - Player removed successfully`);
            return { success: true, tableDeleted: false };
        });
    } catch (error) {
        console.error('❌ [removePlayerFromTable] Error:', error);
        console.error('❌ [removePlayerFromTable] Stack:', error.stack);
        return { error: true, message: error.message };
    }
};

const removeTableById = async tableId => {
    try {
        const result = await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TABLES, tableId);

        if (!result.success) {
            return { error: true, message: 'Table not found' };
        }

        return { error: false };
    } catch (error) {
        throw new Error(error.message);
    }
};

// const deleteInactiveTables = async io => {
//     try {
//         const cutoffDate = new Date(Date.now() - INACTIVE_MINUTES * 60000);
//         console.log(cutoffDate, "cutoffDate");
//         // Fix 1: Add existence check and handle case where updatedAt might not exist
//         const inactiveTablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, {
//             $or: [
//                 { updated_at: { $lt: cutoffDate } },
//                 // { updatedAt: { $exists: false }, createdAt: { $lt: cutoffDate } }, // Fallback to createdAt
//                 // { createdAt: { $lt: cutoffDate }, updatedAt: null }, // Handle null updatedAt
//             ],
//             isCleared: false,
//         });
//         // console.log('Inactive tables result:', inactiveTablesResult);
//         if (!inactiveTablesResult.success || !inactiveTablesResult.data || inactiveTablesResult.data.length === 0) {
//             // console.log('No inactive tables found or error retrieving tables');
//             return;
//         }

//         const inactiveTables = [];
//         for (const table of inactiveTablesResult.data) {
//             console.log(table._id, 'table._id');
//             const populatedTable = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.TABLES, table._id, [
//                 {
//                     path: 'currentPlayers',
//                     collection: mongoHelper.COLLECTIONS.PLAYERS,
//                     populate: {
//                         path: 'user',
//                         collection: mongoHelper.COLLECTIONS.USERS,
//                     },
//                 },
//                 {
//                     path: 'gameState',
//                     collection: mongoHelper.COLLECTIONS.GAME_STATES,
//                 },
//             ]);

//             if (populatedTable.success) {
//                 inactiveTables.push(populatedTable.data);
//             }
//         }
//         console.log(`Found ${inactiveTables.length} inactive tables to clean up`, inactiveTables);
//         for (const table of inactiveTables) {
//             const roomId = table._id.toString();
//             let gameState = table.gameState;

//             const allPlayersAreBots =
//                 table.currentPlayers && table.currentPlayers.length > 0
//                     ? table.currentPlayers.every(player => player.isBot === true || player.user?.isBot === true)
//                     : true;
//             if (allPlayersAreBots) {
//                 // 🚨 Case 1: Only bots → just remove them
//                 console.log(`Table ${roomId} contains only bots. Closing immediately.`);
//                 for (const player of table.currentPlayers) {
//                     await mongoHelper.deleteById(mongoHelper.COLLECTIONS.PLAYERS, player._id);
//                 }
//             } else {
//                 table.currentPlayers && table.currentPlayers.length > 0 && !allPlayersAreBots;
//                 // Process withdrawals only for non-bot human players
//                 for (const player of table.currentPlayers) {
//                     // Skip bots for withdrawal processing
//                     if (player.isBot === true || player.user?.isBot === true) {
//                         continue;
//                     }

//                     if (player.chipsInPlay > 0) {
//                         await blockchainService.queueWithdrawal(
//                             player.user._id,
//                             table._id,
//                             table.tableBlockchainId,
//                             player.chipsInPlay,
//                             player.user.walletAddress,
//                             player.user.email,
//                             player.user.username
//                         );

//                         if (gameState) {
//                             const updatedHistory = [
//                                 ...gameState.actionHistory,
//                                 {
//                                     event: `$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$`,
//                                     isPublicVisible: false,
//                                 },
//                                 {
//                                     event: `Round ${table.gameRoundsCompleted + 1}: WITHDRAWAL: ${player.user.walletAddress} - Amount: ${player.chipsInPlay
//                                         } - TxID: Pending`,
//                                     isPublicVisible: false,
//                                 },
//                                 {
//                                     event: `$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$`,
//                                     isPublicVisible: false,
//                                 },
//                             ];

//                             const updateResult = await mongoHelper.updateById(
//                                 mongoHelper.COLLECTIONS.GAME_STATES,
//                                 gameState._id,
//                                 { actionHistory: updatedHistory },
//                                 mongoHelper.MODELS.GAME_STATE
//                             );

//                             if (updateResult.success) {
//                                 gameState.actionHistory = updatedHistory;
//                             }
//                         }

//                         io.to(player.socketId).emit('withdrawalQueued', {
//                             message: 'Your withdrawal has been queued and is being processed',
//                             status: true,
//                             data: { walletAddress: player.user.walletAddress },
//                         });
//                     }

//                     io.to(player.socketId).emit('youWereEliminated', {
//                         message: allPlayersAreBots ? 'Table closed - only bots remaining.' : 'Inactivity.',
//                         status: false,
//                     });
//                 }
//             }

//             console.log(`🧹 Clearing table ${roomId} - Reason: ${allPlayersAreBots ? 'all_players_bots' : 'inactivity'}`);
 
//             // Delete all players
//             if (table.currentPlayers && table.currentPlayers.length > 0) {
//                 console.log(`🗑️ Deleting ${table.currentPlayers.length} players from table ${roomId}`);
//                 for (const player of table.currentPlayers) {
//                     await mongoHelper.deleteById(mongoHelper.COLLECTIONS.PLAYERS, player._id);
//                 }
//             }

//             // Delete game state
//             if (table.gameState) {
//                 console.log(`🗑️ Deleting game state for table ${roomId}`);
//                 await mongoHelper.deleteById(mongoHelper.COLLECTIONS.GAME_STATES, table.gameState._id || table.gameState);
//             }

//             // Empty the table
//             await mongoHelper.updateById(
//                 mongoHelper.COLLECTIONS.TABLES,
//                 table._id,
//                 {
//                     currentPlayers: [],
//                     isCleared: true,
//                     gameRoundsCompleted: 0,
//                     dealerPosition: null,
//                     currentTurnPosition: null,
//                     smallBlindPosition: null,
//                     bigBlindPosition: null,
//                     gameState: null,
//                     status: 'available'
//                 },
//                 mongoHelper.MODELS.TABLE
//             );

//             console.log(`✅ Table ${roomId} cleared successfully`);

//             // ✅ CRITICAL: Clear in-memory gameStates
//             const { gameStates } = require('./gameStateManager');
//             if (gameStates[roomId]) {
//                 delete gameStates[roomId];
//                 console.log(`🧹 Cleared in-memory gameState for room ${roomId}`);
//             }

//             // ✅ CRITICAL: Remove bot from botManager when table is cleared
//             const botManagerModule = require('../ws/socket');
//             if (botManagerModule && botManagerModule.botManager && botManagerModule.botManager.has(roomId)) {
//                 const bot = botManagerModule.botManager.get(roomId);
//                 if (bot && bot.actionTimer) {
//                     clearTimeout(bot.actionTimer);
//                 }
//                 botManagerModule.botManager.remove(roomId);
//                 console.log(`🤖 Removed bot from botManager for room ${roomId}`);
//             }

//             io.to(roomId).emit('tableCleared', {
//                 message: allPlayersAreBots ? 'Table cleared - only bots remaining' : 'Table cleared due to inactivity',
//                 status: true,
//             });
//         }

//         console.log(`Cleaned up ${inactiveTables.length} inactive tables`);
//     } catch (error) {
//         console.error('Error in cleanup cron job:', error);
//     }
// };

// const deleteAllData = async () => {
//     try {
//         const tableDeleteResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, {});
//         if (tableDeleteResult.success && tableDeleteResult.data.length > 0) {
//             for (const table of tableDeleteResult.data) {
//                 await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TABLES, table._id);
//             }
//             console.log(`Deleted ${tableDeleteResult.data.length} tables`);
//         }

//         const playerDeleteResult = await mongoHelper.find(mongoHelper.COLLECTIONS.PLAYERS, {});
//         if (playerDeleteResult.success && playerDeleteResult.data.length > 0) {
//             for (const player of playerDeleteResult.data) {
//                 await mongoHelper.deleteById(mongoHelper.COLLECTIONS.PLAYERS, player._id);
//             }
//             console.log(`Deleted ${playerDeleteResult.data.length} players`);
//         }

//         const gameStateDeleteResult = await mongoHelper.find(mongoHelper.COLLECTIONS.GAME_STATES, {});
//         if (gameStateDeleteResult.success && gameStateDeleteResult.data.length > 0) {
//             for (const gameState of gameStateDeleteResult.data) {
//                 await mongoHelper.deleteById(mongoHelper.COLLECTIONS.GAME_STATES, gameState._id);
//             }
//             console.log(`Deleted ${gameStateDeleteResult.data.length} game states`);
//         }

//         // ✅ CRITICAL: Clear all in-memory gameStates
//         const { gameStates } = require('./gameStateManager');
//         const roomIds = Object.keys(gameStates);
//         roomIds.forEach(roomId => delete gameStates[roomId]);
//         console.log(`🧹 Cleared ${roomIds.length} in-memory gameStates`);

//         // ✅ CRITICAL: Clear all bots from botManager
//         const botManagerModule = require('../ws/socket');
//         if (botManagerModule && botManagerModule.botManager) {
//             botManagerModule.botManager.bots.forEach((bot, roomId) => {
//                 if (bot.actionTimer) clearTimeout(bot.actionTimer);
//                 botManagerModule.botManager.remove(roomId);
//             });
//             console.log('🤖 Cleared all bots from botManager');
//         }

//         console.log('All table, player, and game state data have been deleted successfully.');
//         return true;
//     } catch (error) {
//         console.error(`Error deleting data: ${error.message}`);
//         throw new Error('Failed to delete all data.');
//     }
// };

const removeInactivePlayers = async (io, gameStates) => {
    try {
        const cutoff = new Date(Date.now() - INACTIVE_THRESHOLD_MINUTES * 60 * 1000);

        // Find players idle beyond cutoff
        const inactivePlayers = await mongoHelper.find(mongoHelper.COLLECTIONS.PLAYERS, { updatedAt: { $lt: cutoff } });

        for (const player of inactivePlayers.data) {
            const table = await getTableById(player.tableId);
            const roomId = table._id.toString();

            console.log(`🛑 Removing inactive player ${player.user?.username} from table ${roomId}`);

            await removePlayerFromTable(roomId, player.socketId, gameStates, io);

            // After removal, check if all remaining players are bots
            const refreshedTable = await getTableById(roomId);
            if (refreshedTable.currentPlayers.length > 0) {
                const humans = refreshedTable.currentPlayers.filter(p => !p.isBot);
                if (humans.length === 0) {
                    console.log(`🤖 All bots left at table ${roomId}, deleting table...`);
                    await removeTableById(roomId);
                    io.to('admin:activeTablesList').emit('tableRemoved', { tableId: roomId });
                }
            }
        }
    } catch (err) {
        console.error('❌ Error in removeInactivePlayers:', err);
    }
};

const rearrangeCurrentPlayers = async (tableId) => {
    try {
        const tableResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.TABLES, tableId, [
            {
                path: 'currentPlayers',
                collection: mongoHelper.COLLECTIONS.PLAYERS,
            },
        ]);

        if (!tableResult.success || !tableResult.data) {
            return false;
        }

        const table = tableResult.data;
        const sortedPlayerIds = table.currentPlayers
            .sort((a, b) => a.seatPosition - b.seatPosition)
            .map(player => player._id);

        const updateResult = await mongoHelper.updateById(
            mongoHelper.COLLECTIONS.TABLES,
            tableId,
            { currentPlayers: sortedPlayerIds },
            mongoHelper.MODELS.TABLE
        );

        return updateResult.success;
    } catch (error) {
        console.error('Error in rearrangeCurrentPlayers:', error);
        return false;
    }
}

// const handlePostLeaveState = async (tableId, gameStates, io) => {
//     const roomId = tableId.toString();
//     try {
//         const table = await getTableById(tableId);

//         if (!table || !gameStates[roomId]) return;

//         const currentPlayerId = gameStates[roomId]?.currentPlayer;
//         const activePlayers = table.currentPlayers.filter(
//             p => !['folded', 'waiting', 'pending-rebuy', 'left'].includes(p.status)
//         );

//         console.log(`🔍 [handlePostLeaveState] Active players remaining: ${activePlayers.length}`);
//         console.log(`🔍 [handlePostLeaveState] Players:`, activePlayers.map(p => ({ username: p.user?.username, status: p.status })));

//         // ✅ Case 1: Only 1 player remains → Award pot and trigger turnover ONLY if game is ongoing
//         if (activePlayers.length === 1) {
//             const winner = activePlayers[0];
//             const gameState = gameStates[roomId]?.gameState;

//             // Get pot from game state or calculate from player contributions
//             let pot = 0;
//             if (gameState) {
//                 const contributedPot = gameState.players?.reduce((sum, p) => sum + (p.chipsInPot || 0), 0) || 0;
//                 pot = Math.max(gameState.pot || 0, contributedPot);
//             }

//             console.log(`🏆 [handlePostLeaveState] Only 1 player remains: ${winner.user?.username} wins ${pot} chips`);

//             if (pot > 0) {
//                 await mongoHelper.updateById(
//                     mongoHelper.COLLECTIONS.PLAYERS,
//                     winner._id,
//                     { chipsInPlay: winner.chipsInPlay + pot },
//                     mongoHelper.MODELS.PLAYER
//                 );
//             }

//             io.to(roomId).emit('gameOver', {
//                 message: `${winner.user?.username} wins ${pot} chips as the last player remaining!`,
//                 status: true,
//                 winner: winner.user?.username,
//                 pot: pot
//             });

//             // ✅ CRITICAL FIX: Set flag for turnover but don't execute it immediately
//             // Let the normal game flow handle turnover after this hand completes
//             gameStates[roomId].needsTurnover = true;
//             gameStates[roomId].turnoverData = {
//                 table,
//                 gameState: gameStates[roomId]?.gameState,
//                 socketId: null,
//                 reason: 'player_left_one_remaining'
//             };

//             console.log(`🔄 [handlePostLeaveState] Turnover flagged for next round (not executing now)`);
//             return;
//         }

//         // ✅ Case 2: No players left → Close table
//         if (activePlayers.length === 0) {
//             console.log(`🪦 [handlePostLeaveState] No players remaining, closing table`);
//             if (gameStates[roomId]) delete gameStates[roomId];
//             io.to(roomId).emit('tableClosed', {
//                 message: 'All players left — table closed.',
//                 status: true,
//             });
//             return;
//         }

//         // ✅ Case 3: Multiple players remain → Continue the game
//         if (activePlayers.length >= 2) {
//             console.log(`✅ [handlePostLeaveState] ${activePlayers.length} players remain, continuing game`);

//             // Check if the leaving player was the current player
//             // We need to check if the current player ID is NOT in the remaining active players
//             const wasCurrentPlayer = currentPlayerId && !activePlayers.some(p => p._id.toString() === currentPlayerId);
//             const leavingPlayerWasCurrentTurn = gameStates[roomId]?.leavingPlayerWasCurrentTurn || false;

//             console.log(`🔍 [handlePostLeaveState] Current player check:`, {
//                 currentPlayerId,
//                 wasCurrentPlayer,
//                 leavingPlayerWasCurrentTurn,
//                 activePlayerIds: activePlayers.map(p => p._id.toString())
//             });

//             // ✅ CRITICAL FIX: Only advance turn if leaving player was the current player
//             // AND we haven't already advanced the turn (check for processing flag)
//             const shouldAdvanceTurn = (wasCurrentPlayer || leavingPlayerWasCurrentTurn || !currentPlayerId) && 
//                                      !gameStates[roomId]?.isAdvancingTurn;

//             // Set flag to prevent duplicate turn advancement
//             if (shouldAdvanceTurn) {
//                 gameStates[roomId].isAdvancingTurn = true;
//                 console.log(`🔒 [handlePostLeaveState] Set isAdvancingTurn flag`);
//             }

//             // Clear the leaving player flag
//             if (gameStates[roomId]?.leavingPlayerWasCurrentTurn) {
//                 delete gameStates[roomId].leavingPlayerWasCurrentTurn;
//                 console.log(`🧹 [handlePostLeaveState] Cleared leavingPlayerWasCurrentTurn flag`);
//             }

//             if (shouldAdvanceTurn) {
//                 console.log(`🔁 [handlePostLeaveState] Advancing turn (wasCurrentPlayer: ${wasCurrentPlayer}, noCurrentPlayer: ${!currentPlayerId})`);
//                 const { getAvailableActions } = require('./game.service');

//                 // Find next valid player
//                 const nextPlayer = await getNextPlayerInTurn(table, false, false);

//                 if (nextPlayer) {
//                     console.log(`👤 [handlePostLeaveState] Next player: ${nextPlayer.user?.username}`);

//                     // Validate next player can act
//                     const canAct = nextPlayer.chipsInPlay > 0 && !['folded', 'all-in', 'waiting', 'pending-rebuy'].includes(nextPlayer.status);

//                     if (canAct) {
//                         const gameState = gameStates[roomId]?.gameState;
//                         if (gameState) {
//                             const opts = await getAvailableActions(
//                                 nextPlayer,
//                                 gameState.currentBet ?? 0,
//                                 gameStates[roomId].playerBets?.[nextPlayer.socketId] || 0,
//                                 gameState.pot,
//                                 table.tableTypeId.smallBlind,
//                                 table.tableTypeId.bigBlind,
//                                 gameStates,
//                                 roomId,
//                                 table
//                             );

//                             // ✅ CRITICAL: Update game state and clear advancing flag
//                             gameStates[roomId].currentPlayer = nextPlayer._id.toString();
//                             gameStates[roomId].currentPlayerInTurn = nextPlayer.socketId;
//                             gameStates[roomId].currentTurnPlayer = nextPlayer.socketId;
//                             gameStates[roomId].turnStartTime = Date.now();
//                             gameStates[roomId].isAdvancingTurn = false; // Clear flag after successful advancement
//                             gameStates[roomId].nextPlayerOptions = {
//                                 playerId: nextPlayer._id.toString(),
//                                 playerSocketId: nextPlayer.socketId,
//                                 availableOptions: opts.options,
//                                 callAmount: opts.callAmount,
//                                 minRaiseAmount: opts.minRaiseAmount,
//                                 maxRaiseAmount: opts.maxRaiseAmount,
//                                 raiseSteps: opts.raiseSteps,
//                                 betIncrement: opts.betIncrement,
//                             };

//                             // Emit turn to next player
//                             io.to(nextPlayer.socketId).emit('playerTurn', {
//                                 data: {
//                                     playerId: nextPlayer._id,
//                                     availableOptions: opts.options,
//                                     callAmount: opts.callAmount,
//                                     minRaiseAmount: opts.minRaiseAmount,
//                                     maxRaiseAmount: opts.maxRaiseAmount,
//                                     raiseSteps: opts.raiseSteps,
//                                     betIncrement: opts.betIncrement,
//                                 },
//                                 message: `${nextPlayer.user?.username}, it's your turn.`,
//                                 status: true,
//                             });

//                             // Notify room about turn change
//                             io.to(roomId).emit('turnAdvanced', {
//                                 message: `Turn advanced to ${nextPlayer.user?.username}`,
//                                 currentPlayer: nextPlayer.user?.username,
//                                 status: true
//                             });

//                             // Trigger bot action if next player is a bot (with delay to ensure state is settled)
//                             if (nextPlayer.isBot) {
//                                 console.log(`🤖 [handlePostLeaveState] Next player is bot, scheduling bot action`);
//                                 setTimeout(() => {
//                                     botEmitter.emit('executeBotAction', {
//                                         roomId,
//                                         playerId: nextPlayer._id,
//                                         socketId: nextPlayer.socketId,
//                                         username: nextPlayer.user?.username
//                                     });
//                                 }, 300);
//                             }
//                         }
//                     } else {
//                         console.warn(`⚠️ [handlePostLeaveState] Next player ${nextPlayer.user?.username} cannot act, finding another player`);
//                         // Clear advancing flag before recursion
//                         if (gameStates[roomId]?.isAdvancingTurn) {
//                             gameStates[roomId].isAdvancingTurn = false;
//                         }
//                         // Recursively try to find next valid player
//                         return await handlePostLeaveState(tableId, gameStates, io);
//                     }
//                 } else {
//                     console.warn(`⚠️ [handlePostLeaveState] No next player found`);
//                     // Clear advancing flag if no next player
//                     if (gameStates[roomId]?.isAdvancingTurn) {
//                         gameStates[roomId].isAdvancingTurn = false;
//                     }
//                 }
//             } else {
//                 console.log(`ℹ️ [handlePostLeaveState] Non-current player left, game continues normally`);
//                 // Clear advancing flag if we're not advancing
//                 if (gameStates[roomId]?.isAdvancingTurn) {
//                     gameStates[roomId].isAdvancingTurn = false;
//                 }
//             }
//         }

//     } catch (error) {
//         console.error('❌ [handlePostLeaveState] Error:', error);
//     } finally {
//         // ✅ CRITICAL: Always clear the advancing flag
//         if (gameStates[roomId]?.isAdvancingTurn) {
//             gameStates[roomId].isAdvancingTurn = false;
//             console.log(`🧹 [handlePostLeaveState] Cleared isAdvancingTurn flag in finally block`);
//         }
//     }
// };
const findTableWithVacanciesInSubTier = async(playerCount, tableTypeId, subTierId) => {
    try {
      console.log(`🔍 Finding table in sub-tier: ${subTierId}, tableType: ${tableTypeId}`);
      
      // Get the sub-tier using mongoHelper
      const subTierResult = await mongoHelper.findByIdWithPopulate(
        mongoHelper.COLLECTIONS.SUB_TIERS, 
        subTierId, 
        [{ path: 'tierId', collection: mongoHelper.COLLECTIONS.TIERS }]
      );
            
      if (!subTierResult.success || !subTierResult.data) {
        throw new Error(`Sub-tier ${subTierId} not found`);
      }

      const subTier = subTierResult.data;

      // Find tables in this sub-tier using mongoHelper
      const tablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, {
        subTierId: subTierId,
        'status': { $in: ['waitingForPlayers', 'gameOngoing', 'in-use'] }
      });

      const tables = tablesResult.data || [];
      console.log(`Found ${tables.length} tables in sub-tier ${subTierId}`);

      // Find table with available seats
      for (const table of tables) {
        const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId);
        const tableType = tableTypeResult.data;
        
        if (tableType && 
            tableType._id.toString() === tableTypeId.toString() &&
            table.currentPlayers.length < (subTier.tableConfig?.maxSeats || 6)) {
          
          console.log(`✅ Found table in sub-tier ${subTierId}: ${table._id}`);
          return table;
        }
      }

      console.log(`❌ No available tables found in sub-tier: ${subTierId}`);
      return null;

    } catch (error) {
      console.error('Error finding table in sub-tier:', error);
      throw error;
    }
  }

  // Create table for specific sub-tier
  async function createTableForSubTier(playerCount, tableTypeId, blockchainTableId, blockchainAddress, subTierId, userId) {
    try {
      console.log(`🆕 Creating table for sub-tier: ${subTierId}`);
      
      // Create the poker table (your existing logic)
      const pokerTable = await createTable(playerCount, tableTypeId, blockchainTableId, blockchainAddress);
      
      // Set subTierId on the table using mongoHelper
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TABLES,
        pokerTable._id,
        { subTierId: subTierId }
      );

      console.log(`✅ Created table: ${pokerTable._id} for sub-tier: ${subTierId}`);
      
      return pokerTable;

    } catch (error) {
      console.error('Error creating table for sub-tier:', error);
      throw error;
    }
  }

  // Get tables by sub-tier (for monitoring)
  async function getTablesBySubTier(subTierId) {
    const tablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, { 
      subTierId: subTierId 
    });
    
    return tablesResult.data || [];
  }

  // Check if player can join table (cooldown and sub-tier validation)
  async function canPlayerJoinTable(playerId, tableId, subTierId) {
    try {
      const matchmakingTable = await MatchmakingTable.findOne({ 
        blockchainTableId: tableId,
        subTierId: subTierId 
      });
      
      if (!matchmakingTable) {
        return { canJoin: false, reason: 'Table not found in specified sub-tier' };
      }

      // Check cooldown conflicts
      const matchmakingService = require('./matchmaking.service');
      const hasCooldownConflict = await matchmakingService.hasCooldownConflict(
        playerId, 
        matchmakingTable.currentPlayerIds, 
        matchmakingTable.tierId
      );

      if (hasCooldownConflict) {
        return { canJoin: false, reason: 'Cooldown conflict with players at this table' };
      }

      // Check seat availability
      if (matchmakingTable.currentPlayerIds.length >= matchmakingTable.tableConfig.maxSeats) {
        return { canJoin: false, reason: 'Table is full' };
      }

      return { canJoin: true };

    } catch (error) {
      console.error('Error checking player join eligibility:', error);
      return { canJoin: false, reason: error.message };
    }
  }




module.exports = {
    createTable,
    getTableById,
    handleArchivedTable,
    findTableOrCreateThroughBlockchain,
    findTableWithVacancies,
    getTableByBlockChainId,
    findTableByPlayerId,
    addUserToTable,
    removePlayerFromTable,
    removeTableById,
    handleTableTurnover,
    // deleteInactiveTables,
    // deleteAllData,
    removeInactivePlayers,
    rearrangeCurrentPlayers,
    getNextPlayerInTurn,
    // handlePostLeaveState,
    clearTableWithOnlyBots,
    findTableWithVacanciesInSubTier,
    createTableForSubTier
}

