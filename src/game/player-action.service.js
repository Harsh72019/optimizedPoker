// src/game/player-action.service.js

const gameStateManager = require('../state/game-state');
const PokerEngine = require('../engine/poker-engine');
const GameStateMachine = require('../engine/game-state-machine');
const gameQueue = require('../queues/game-queue');
const ProbabilityCalculator = require('./probability-calculator');
const { emitSuccess } = require('../websocket/socket-emitter');
class PlayerActionService {
    constructor(io, timerManager, orchestrator) {
        this.io = io;
        this.timerManager = timerManager;
        this.orchestrator = orchestrator;
    }

    async forceEndHand(tableId) {
        const gameState = await gameStateManager.getGame(tableId);

        gameState.phase = 'COMPLETED';

        await gameStateManager.updateGame(tableId, gameState);

        this.orchestrator.onHandCompleted(tableId);
    }

    async handle(tableId, playerId, action, amount = 0) {

        console.log(`🎮 [ACTION] Player ${playerId} attempting ${action} ${amount || ''} at table ${tableId}`);
        const locked = await gameStateManager.acquireLock(tableId);
        if (!locked) throw new Error('Table busy');

        try {
            const gameState = await gameStateManager.getGame(tableId);
            if (!gameState) throw new Error('Game not found');
            if (gameState.phase === 'COMPLETED') {
                console.log('🛑 Hand already completed. Ignoring action.');
                return gameState;
            }

            const normalizedPlayerId = playerId.toString();
            const player = gameState.players.find(p => p.id === normalizedPlayerId);

            if (!player) throw new Error('Player not in game');

            if (gameState.currentPlayerId !== normalizedPlayerId) {
                throw new Error('Not your turn');
            }

            const validation = PokerEngine.validateAction(player, gameState);

            if (!validation.options.includes(action)) {
                throw new Error('Invalid action');
            }

            emitSuccess(this.io.to(tableId), 'playerActionStarted', { playerId, action, amount }, 'Action started');

            let tableState = await require('../table/table-manager.service').getTable(tableId);
            const actingPlayer = tableState.players.find(p => p.userId === normalizedPlayerId);

            this.applyAction(gameState, player, action, amount, validation);
            console.log(`✅ [ACTION APPLIED] ${action} by ${playerId}`);

            // Emit specific action events
            if (action === 'fold') {
                const tableState = await require('../table/table-manager.service').getTable(tableId);
                const updatedGameState = await gameStateManager.getGame(tableId);
                const formattedData = this.formatTableData(tableState, updatedGameState);
                emitSuccess(this.io.to(tableId), 'playerFolded', formattedData, 'Player folded');
            } else if (action === 'all-in') {
                emitSuccess(this.io.to(tableId), 'playerAllIn', { playerId, amount: player.chips }, 'Player all-in');
            }

            const actionData = {
                playerId: normalizedPlayerId,
                username: actingPlayer?.username || 'Player',
                action,
                amount,
                result: true,
                timestamp: new Date().toISOString()
            };

            emitSuccess(this.io.to(tableId), 'actionTaken', actionData, this.getActionMessage(action, actionData.username, amount));
            emitSuccess(this.io.to(tableId), 'playerActionEnded', { playerId, action }, 'Action ended');

            if (GameStateMachine.isBettingRoundComplete(gameState)) {
                console.log(`🔄 [BETTING COMPLETE] Moving to next phase from ${gameState.phase}`);
                emitSuccess(this.io.to(tableId), 'betsReset', { pot: gameState.pot }, 'Bets collected');
                this.moveToNextPhase(gameState);
            } else {
                console.log(`➡️ [NEXT PLAYER] Moving turn from ${playerId}`);
                this.moveToNextPlayer(gameState);
            }

            await gameStateManager.updateGame(tableId, gameState);
            console.log(`💾 [STATE SAVED] Phase: ${gameState.phase}, Pot: ${gameState.pot}`);

            tableState = await require('../table/table-manager.service').getTable(tableId);
            const formattedData = this.formatTableData(tableState, gameState);
            emitSuccess(this.io.to(tableId), 'tableInfo', formattedData, 'Table updated');

            // Calculate and emit winning probabilities
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            if (probabilities.length > 0) {
                emitSuccess(this.io.to(tableId), 'winningProbability', probabilities, 'Probabilities updated');
            }

            if (gameState.phase !== 'COMPLETED') {
                const playerTurnData = this.formatPlayerTurnData(gameState, gameState.currentPlayerId, tableState);
                emitSuccess(this.io.to(tableId), 'playerTurn', playerTurnData, `${playerTurnData.username}, it's your turn to act.`);
                emitSuccess(this.io.to(tableId), 'currentPlayerTurn', gameState.currentPlayerId, 'Current turn');
                this.timerManager.startTimer(tableId, gameState.currentPlayerId);
            } else {
                console.log(`🏁 [HAND COMPLETE] Starting cleanup`);
                this.timerManager.clearTimer(tableId);
                
                // Persist hand BEFORE deleting game state
                const handPersister = require('../workers/hand-persister');
                await handPersister.persist(tableId);
                
                // Now delete game state and trigger next hand
                await gameStateManager.deleteGame(tableId);
                this.orchestrator.onHandCompleted(tableId);
                console.log(`✅ [CLEANUP DONE]`);
            }
            return gameState;

        } finally {
            await gameStateManager.releaseLock(tableId);
        }
    }

    isAllInRunoutRequired(gameState) {
        const nonFolded = gameState.players.filter(
            p => p.status !== 'FOLDED'
        );

        const active = nonFolded.filter(
            p => p.status === 'ACTIVE'
        );

        // If 0 or 1 ACTIVE players → runout required
        return active.length <= 1;
    }

    applyAction(gameState, player, action, amount, validation) {
        const callAmount = validation.callAmount || 0;

        switch (action) {
            case 'fold':
                player.status = 'FOLDED';
                break;

            case 'check':
                break;

            case 'call':
                this.applyBet(gameState, player, callAmount);
                break;

            case 'raise':
                if (amount < validation.minRaise)
                    throw new Error('Raise too small');

                this.applyBet(gameState, player, amount);
                // gameState.currentBet = player.chipsInPot;

                gameState.players.forEach(p => {
                    if (p.id !== player.id && p.status === 'ACTIVE') {
                        p.hasActed = false;
                    }
                });
                break;

            case 'all-in':
                this.applyBet(gameState, player, player.chips);
                player.status = 'ALL_IN';
                break;
        }

        player.hasActed = true;
    }

    applyBet(gameState, player, amount) {
        const actual = Math.min(amount, player.chips);

        player.chips -= actual;

        gameState.streetBets[player.id] += actual;
        gameState.totalContributions[player.id] += actual;

        // If raise
        if (gameState.streetBets[player.id] > gameState.currentBet) {
            const raiseSize =
                gameState.streetBets[player.id] - gameState.currentBet;

            gameState.lastRaiseAmount = raiseSize;
            gameState.currentBet = gameState.streetBets[player.id];

            // Reset others' hasActed
            gameState.players.forEach(p => {
                if (p.id !== player.id && p.status === 'ACTIVE') {
                    p.hasActed = false;
                }
            });
        }
    }

    moveToNextPlayer(gameState) {
        const active = gameState.players
            .filter(p =>
                p.status === 'ACTIVE' &&
                p.chips > 0
            )
            .sort((a, b) => a.seatPosition - b.seatPosition);

        // Edge case: No active players left
        if (active.length === 0) {
            console.log('⚠️ [NO ACTIVE PLAYERS] Moving to showdown');
            this.moveToNextPhase(gameState);
            return;
        }

        // Edge case: Only 1 active player left
        if (active.length === 1) {
            console.log('⚠️ [ONLY 1 ACTIVE] Moving to showdown');
            this.moveToNextPhase(gameState);
            return;
        }

        const currentIndex =
            active.findIndex(p => p.id === gameState.currentPlayerId);

        const next =
            active[(currentIndex + 1) % active.length];

        gameState.currentPlayerId = next.id;
    }

    runoutBoard(gameState) {
        while (gameState.boardCards.length < 5) {
            gameState.boardCards.push(
                gameState.deck.pop()
            );
        }
        gameState.phase = 'SHOWDOWN';
    }

    moveToNextPhase(gameState) {
        if (gameState.phase === 'COMPLETED') return;

        for (const id in gameState.streetBets) {
            gameState.pot += gameState.streetBets[id];
            gameState.streetBets[id] = 0;
        }

        const activePlayers = gameState.players.filter(p => p.status !== 'FOLDED');

        if (activePlayers.length === 1) {
            console.log(`🏆 [WINNER] ${activePlayers[0].id} wins by fold`);
            const winner = activePlayers[0];
            const winAmount = gameState.pot;
            winner.chips += winAmount;
            gameState.pot = 0;
            gameState.phase = 'COMPLETED';
            emitSuccess(this.io.to(gameState.tableId), 'gameOver', { winner: { playerId: winner.id, amount: winAmount } }, 'Game over');
            emitSuccess(this.io.to(gameState.tableId), 'winners', [{ playerId: winner.id, amount: winAmount }], 'Winner');
            emitSuccess(this.io.to(gameState.tableId), 'callShowDown', {}, 'Showdown called');
            return;
        }

        if (this.isAllInRunoutRequired(gameState)) {
            console.log(`⚡ [ALL-IN RUNOUT] Auto-completing board`);
            this.runoutBoard(gameState);
            this.handleShowdown(gameState);
            return;
        }

        const nextPhase = GameStateMachine.nextPhase(gameState.phase);
        gameState.phase = nextPhase;
        emitSuccess(this.io.to(gameState.tableId), 'newPhase', { phase: nextPhase }, 'New phase');

        if (nextPhase === 'FLOP') {
            gameState.boardCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
            console.log(`🃏 [FLOP] ${gameState.boardCards.slice(0, 3).join(', ')}`);
            emitSuccess(this.io.to(gameState.tableId), 'communityCardsDealt', 
                gameState.boardCards.slice(0, 3), 'Flop dealt');
            
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            emitSuccess(this.io.to(gameState.tableId), 'winningProbability', probabilities, 'Probabilities updated');
        }

        if (nextPhase === 'TURN') {
            gameState.boardCards.push(gameState.deck.pop());
            console.log(`🃏 [TURN] ${gameState.boardCards[3]}`);
            emitSuccess(this.io.to(gameState.tableId), 'communityCardsDealt', 
                [gameState.boardCards[3]], 'Turn dealt');
            
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            emitSuccess(this.io.to(gameState.tableId), 'winningProbability', probabilities, 'Probabilities updated');
        }

        if (nextPhase === 'RIVER') {
            gameState.boardCards.push(gameState.deck.pop());
            console.log(`🃏 [RIVER] ${gameState.boardCards[4]}`);
            emitSuccess(this.io.to(gameState.tableId), 'communityCardsDealt', 
                [gameState.boardCards[4]], 'River dealt');
            
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            emitSuccess(this.io.to(gameState.tableId), 'winningProbability', probabilities, 'Probabilities updated');
        }

        if (nextPhase === 'SHOWDOWN') {
            console.log(`🎰 [SHOWDOWN] Evaluating hands`);
            this.handleShowdown(gameState);
            return;
        }

        gameState.currentBet = 0;
        gameState.players.forEach(p => { p.hasActed = false; });
        gameState.currentPlayerId = this.getFirstAfterDealer(gameState);
        
        // Edge case: No active player to act
        if (!gameState.currentPlayerId) {
            console.log('⚠️ [NO PLAYER TO ACT] Moving to showdown');
            this.handleShowdown(gameState);
            return;
        }
        
        console.log(`🔄 [NEW ROUND] ${gameState.phase} begins`);
    }

    formatPlayerTurnData(gameState, playerId, tableState) {
        const player = gameState.players.find(p => p.id === playerId);
        if (!player) return { playerId };

        const tablePlayer = tableState?.players.find(p => p.userId === playerId);
        const username = tablePlayer?.username || 'Player';

        const currentBet = gameState.currentBet || 0;
        const playerBet = gameState.streetBets[playerId] || 0;
        const callAmount = Math.max(0, currentBet - playerBet);
        const betIncrement = gameState.bigBlind || 0.04;
        const minRaise = currentBet + (gameState.lastRaiseAmount || betIncrement);
        const maxRaise = player.chips + playerBet;

        const availableOptions = [];
        availableOptions.push('fold');
        
        if (callAmount === 0) {
            availableOptions.push('check');
        } else if (player.chips >= callAmount) {
            availableOptions.push('call');
        }
        
        if (player.chips > callAmount && maxRaise >= minRaise) {
            availableOptions.push('raise');
        }

        const raiseSteps = [
            { label: '2x BB', value: betIncrement * 2 },
            { label: '3x BB', value: betIncrement * 3 },
            { label: 'Pot', value: gameState.pot || 0 },
            { label: 'All-in', value: maxRaise }
        ].filter(step => step.value <= maxRaise && step.value >= minRaise);

        return {
            playerId,
            username,
            availableOptions,
            callAmount,
            minRaiseAmount: minRaise > maxRaise ? null : minRaise,
            maxRaiseAmount: maxRaise >= minRaise ? maxRaise : null,
            raiseSteps: raiseSteps.length > 0 ? raiseSteps : null,
            betIncrement
        };
    }

    handleShowdown(gameState) {
        for (const id in gameState.streetBets) {
            gameState.pot += gameState.streetBets[id];
            gameState.streetBets[id] = 0;
        }

        console.log(`💰 [SHOWDOWN] Pot: ${gameState.pot}`);
        console.log(`💰 [CONTRIBUTIONS]`, gameState.totalContributions);
        
        const results = PokerEngine.evaluateShowdown(gameState);
        console.log(`💰 [SHOWDOWN RESULTS] ${results.length} winner(s)`);

        results.forEach(r => {
            const winner = gameState.players.find(p => p.id === r.playerId);
            winner.chips += r.amount;
            console.log(`💵 Player ${r.playerId} wins ${r.amount}`);
        });

        emitSuccess(this.io.to(gameState.tableId), 'showdownResults', { winners: results }, 'Showdown complete');
        emitSuccess(this.io.to(gameState.tableId), 'winners', results, 'Winners');
        emitSuccess(this.io.to(gameState.tableId), 'callShowDown', {}, 'Showdown called');
        
        // Reveal cards one by one
        gameState.players.filter(p => p.status !== 'FOLDED').forEach(p => {
            emitSuccess(this.io.to(gameState.tableId), 'revealPlayerCards', {
                playerId: p.id,
                hand: p.cards
            }, 'Cards revealed');
        });
        
        emitSuccess(this.io.to(gameState.tableId), 'revealingDone', {}, 'All cards revealed');

        console.log("🎰 Players at showdown:",
            gameState.players.map(p => ({
                id: p.id,
                status: p.status,
                cards: p.cards
            }))
        );
        gameState.phase = 'COMPLETED';
        gameState.pot = 0;
    }
    getFirstAfterDealer(gameState) {
        const active = gameState.players
            .filter(p => p.status === 'ACTIVE')
            .sort((a, b) => a.seatPosition - b.seatPosition);

        // Edge case: No active players
        if (active.length === 0) {
            console.log('⚠️ [NO ACTIVE PLAYERS] Cannot determine first player');
            return null;
        }

        const dealerIndex = active.findIndex(
            p => p.seatPosition === gameState.dealerPosition
        );

        return active[(dealerIndex + 1) % active.length].id;
    }

    formatTableData(tableState, gameState) {
        const formattedPlayers = tableState.players.map(player => {
            const gamePlayer = gameState?.players.find(p => p.id === player.userId);
            return {
                _id: player.userId,
                username: player.username,
                chips: player.chips,
                seatPosition: player.seatPosition,
                status: gamePlayer?.status || 'waiting',
                socketId: player.socketId,
                isAway: player.isAway || false,
                currentRoundBet: gameState ? (gameState.streetBets[player.userId] || 0) : 0
            };
        });

        return {
            maxPlayers: tableState.maxPlayers || 9,
            currentPlayers: formattedPlayers,
            gameState: gameState ? {
                pot: gameState.pot || 0,
                phase: gameState.phase,
                currentPlayerId: gameState.currentPlayerId,
                currentBet: gameState.currentBet || 0,
                boardCards: gameState.boardCards || [],
                dealerPosition: gameState.dealerPosition,
                smallBlindPosition: gameState.smallBlindPosition,
                bigBlindPosition: gameState.bigBlindPosition
            } : null
        };
    }

    getActionMessage(action, username, amount) {
        switch (action) {
            case 'check':
                return `${username} checked.`;
            case 'fold':
                return `${username} folded.`;
            case 'call':
                return `${username} called ${amount} chips.`;
            case 'raise':
                return `${username} raised to ${amount} chips.`;
            case 'all-in':
                return `${username} went all-in with ${amount} chips.`;
            default:
                return `${username} performed ${action}.`;
        }
    }
}

module.exports = PlayerActionService;