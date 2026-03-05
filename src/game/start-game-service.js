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
            // 2️⃣ Load SubTier
            let subTier = await mongoHelper.findById(
                mongoHelper.COLLECTIONS.SUB_TIERS,
                matchmakingTable?.data?.subTierId
            );

            if (!subTier)
                throw new Error('SubTier not found');
            subTier = subTier.data
            // 3️⃣ Extract blinds
            const bigBlindAmount = subTier.tableConfig.bb;
            const smallBlindAmount = bigBlindAmount / 2;

            console.log(
                `🎴 [BLINDS POSTED] SB: ${smallBlindAmount}, BB: ${bigBlindAmount}`
            );
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

            gameState.lastRaiseAmount = bigBlindAmount;

            // Initialize tracking maps
            gameState.players.forEach(p => {
                gameState.streetBets[p.id] = 0;
                gameState.totalContributions[p.id] = 0;
            });

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
            await tableManager.setStatus(tableId, 'IN_PROGRESS');

            emitSuccess(
                this.io.to(tableId),
                'gameStarted',
                this.formatGameStartData(tableState, gameState),
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
                    amount: smallBlindAmount,
                    player: gameState.players.find(p => p.seatPosition === gameState.smallBlindPosition)
                },
                'Small blind posted'
            );

            emitSuccess(
                this.io.to(tableId),
                'bigBlind',
                { 
                    position: gameState.bigBlindPosition, 
                    amount: bigBlindAmount,
                    player: gameState.players.find(p => p.seatPosition === gameState.bigBlindPosition)
                },
                'Big blind posted'
            );

            gameState.players.forEach(player => {
                this.io.to(tableId).emit('receiveHand', {
                    status: true,
                    data: {
                        hand: player.cards
                    },
                    message: 'Hand dealt'
                });
            });

            console.log(`✅ [GAME STARTED] First turn: ${gameState.currentPlayerId}`);

        } catch (err) {
            console.error(`❌ start game error for ${tableId}:`, err.message);
            throw err;
        } finally {
            await gameStateManager.releaseLock(tableId);
        }

        if (gameState) {
            await this.timerManager.startTimer(tableId, gameState.currentPlayerId);
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
                bigBlindPosition: gameState.bigBlindPosition
            }
        };
    }
}

module.exports = StartGameService;