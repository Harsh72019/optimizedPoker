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
            
            emitSuccess(this.io.to(tableId), 'playerActionStarted', { playerId, action, amount }, 'Action started');

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

            // 🎯 ENHANCED VALIDATION: Pass tableId for private table detection
            const validation = await PokerEngine.validateAction(player, gameState, tableId);
            console.log(`🎯 [VALIDATION] Available actions for ${playerId}:`, validation.actions || validation.options);
            console.log(`🎯 [VALIDATION] Stakes type: ${validation.stakesType || 'NO_LIMIT'}`);

            // Check if action is available (support both old and new validation format)
            const availableActions = validation.options || Object.keys(validation.actions || {}).filter(key => validation.actions[key]);
            console.log(`🔍 [DEBUG] Available actions array: ${availableActions}`);
            console.log(`🔍 [DEBUG] Requested action: ${action}`);
            console.log(`🔍 [DEBUG] Action available check: ${availableActions.includes(action)}`);
            
            if (!availableActions.includes(action)) {
                throw new Error(`Invalid action. Available: ${availableActions.join(', ')}. Stakes: ${validation.stakesType || 'NO_LIMIT'}`);
            }
            
            console.log(`✅ [DEBUG] Action ${action} is valid, proceeding...`);
            
            // 🎯 ENHANCED BET VALIDATION: Validate bet amounts for private tables
            if ((action === 'raise' || action === 'bet') && amount > 0) {
                console.log(`🔍 [DEBUG] Validating bet amount: ${amount}`);
                const betValidation = await PokerEngine.validateBetAmount(player, gameState, amount, action, tableId);
                console.log(`🔍 [DEBUG] Bet validation result:`, betValidation);
                if (!betValidation.valid) {
                    throw new Error(`${betValidation.error}. Suggested: ${betValidation.suggestedAmount || 'N/A'}`);
                }
                console.log(`✅ [BET VALID] ${action} amount ${amount} validated for ${validation.stakesType || 'NO_LIMIT'} table`);
            }
            
            console.log(`🔍 [DEBUG] Getting table state...`);

            let tableState = await require('../table/table-manager.service').getTable(tableId);
            console.log(`🔍 [DEBUG] Got table state, finding acting player...`);
            const actingPlayer = tableState.players.find(p => p.userId === normalizedPlayerId);
            console.log(`🔍 [DEBUG] Acting player found: ${actingPlayer ? actingPlayer.username : 'NOT FOUND'}`);

            console.log(`🔍 [DEBUG] Applying action: ${action}`);
            this.applyAction(gameState, player, action, amount, validation);
            console.log(`✅ [ACTION APPLIED] ${action} by ${playerId}`);
            
            console.log(`🔍 [DEBUG] Action applied successfully, continuing...`);

            // Emit specific action events
            if (action === 'fold') {
                const tableState = await require('../table/table-manager.service').getTable(tableId);
                const formattedData = this.formatTableData(tableState, gameState);
                emitSuccess(this.io.to(tableId), 'playerFolded', formattedData, 'Player folded');
            } else if (action === 'all-in') {
                emitSuccess(this.io.to(tableId), 'playerAllIn', { playerId, amount: player.chips }, 'Player all-in');
            }

            console.log(`🔍 [DEBUG] Creating action data...`);
            const actionData = {
                playerId: normalizedPlayerId,
                username: actingPlayer?.username || 'Player',
                action,
                amount: action === 'call' ? (validation.callAmount || validation.actions?.call || 0) : amount,
                result: true,
                timestamp: new Date().toISOString(),
                stakesType: validation.stakesType || 'NO_LIMIT'
            };
            console.log(`🔍 [DEBUG] Action data created:`, actionData);

            console.log(`🔍 [DEBUG] Emitting action events...`);
            emitSuccess(this.io.to(tableId), 'actionTaken', actionData, this.getActionMessage(action, actionData.username, actionData.amount));
            emitSuccess(this.io.to(tableId), 'playerActionEnded', { playerId, action }, 'Action ended');
            console.log(`🔍 [DEBUG] Action events emitted successfully`);

            if (GameStateMachine.isBettingRoundComplete(gameState)) {
                console.log(`🔄 [BETTING COMPLETE] Moving to next phase from ${gameState.phase}`);
                
                // Debug: Log betting round completion details
                const activePlayers = gameState.players.filter(p => p.status === 'ACTIVE');
                console.log(`🔍 [DEBUG] Active players: ${activePlayers.length}`);
                activePlayers.forEach(p => {
                    const playerBet = gameState.streetBets[p.id] || 0;
                    console.log(`🔍 [DEBUG] Player ${p.id}: hasActed=${p.hasActed}, bet=${playerBet}, currentBet=${gameState.currentBet}, status=${p.status}`);
                });
                
                emitSuccess(this.io.to(tableId), 'betsReset', { pot: gameState.pot }, 'Bets collected');
                this.moveToNextPhase(gameState);
            } else {
                console.log(`➡️ [NEXT PLAYER] Moving turn from ${playerId}`);
                
                // Debug: Log why betting round is not complete
                const activePlayers = gameState.players.filter(p => p.status === 'ACTIVE');
                console.log(`🔍 [DEBUG] Betting round NOT complete. Active players: ${activePlayers.length}`);
                activePlayers.forEach(p => {
                    const playerBet = gameState.streetBets[p.id] || 0;
                    const hasActedAndMatched = p.hasActed && (playerBet === gameState.currentBet || p.status === 'ALL_IN');
                    console.log(`🔍 [DEBUG] Player ${p.id}: hasActed=${p.hasActed}, bet=${playerBet}, currentBet=${gameState.currentBet}, status=${p.status}, complete=${hasActedAndMatched}`);
                });
                
                this.moveToNextPlayer(gameState);
            }

            await gameStateManager.updateGame(tableId, gameState);
            const refreshedGameState = await gameStateManager.getGame(tableId);
            console.log(`💾 [STATE SAVED] Phase: ${gameState.phase}, Pot: ${gameState.pot}`);

            tableState = await require('../table/table-manager.service').getTable(tableId);
            const formattedData = this.formatTableData(tableState, refreshedGameState);
            emitSuccess(this.io.to(tableId), 'tableInfo', formattedData, 'Table updated');

            // Calculate and emit winning probabilities
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            if (probabilities.length > 0) {
                emitSuccess(this.io.to(tableId), 'winningProbability', probabilities, 'Probabilities updated');
            }

            if (gameState.phase !== 'COMPLETED') {
                console.log(`⏱️ [TIMER] Starting timer for next player: ${gameState.currentPlayerId}`);
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

        }catch (err) { console.log(err);
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
        // Use the new production-grade action handler
        const gameActionHandler = require('../services/game-action-handler.service');
        
        // For backward compatibility, handle the action application here
        // The new handler is used in the main handle method
        const callAmount = validation.callAmount || validation.actions?.call || 0;

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
                if (amount < (validation.minRaise || validation.actions?.raise?.min)) {
                    throw new Error('Raise too small');
                }
                this.applyBet(gameState, player, amount);
                
                // Reset other players' hasActed status for raises
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

        console.log(`🔍 [MOVE NEXT] Active players with chips: ${active.length}`);
        active.forEach(p => {
            console.log(`🔍 [MOVE NEXT] Player ${p.id}: status=${p.status}, chips=${p.chips}, seat=${p.seatPosition}`);
        });

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
        
        console.log(`🔍 [MOVE NEXT] Current player ${gameState.currentPlayerId} is at index ${currentIndex}`);

        const next =
            active[(currentIndex + 1) % active.length];
        
        console.log(`🔍 [MOVE NEXT] Next player: ${next.id}`);

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
            
            // 🕐 CHECK FOR TIME EXPIRY: End game if time limit reached
            this.checkTimeExpiryAndEnd(gameState);
            
            gameState.phase = 'COMPLETED';
            emitSuccess(this.io.to(gameState.tableId), 'gameOver', { winner: { playerId: winner.id, amount: winAmount } }, 'Game over');
            const formattedWinners = [{
                potType: "Main Pot",
                amount: winAmount,
                winners: [{
                    username: 'Player',
                    amount: winAmount,
                    status: 'active',
                    winningHand: 'High Card',
                    cards: {
                        holeCards: winner.cards || [],
                        communityCards: gameState.boardCards || [],
                        bestHand: winner.cards || []
                    }
                }]
            }];
            emitSuccess(this.io.to(gameState.tableId), 'winners', formattedWinners, 'Winner');
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
        emitSuccess(this.io.to(gameState.tableId), 'newPhase', { phase: nextPhase },`${nextPhase} phase started`);

        if (nextPhase === 'FLOP') {
            gameState.boardCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
            console.log(`🃏 [FLOP] ${gameState.boardCards.slice(0, 3).join(', ')}`);
            emitSuccess(this.io.to(gameState.tableId), 'communityCardsDealt', 
                gameState.boardCards, 'Flop dealt');
            
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            emitSuccess(this.io.to(gameState.tableId), 'winningProbability', probabilities, 'Probabilities updated');
        }

        if (nextPhase === 'TURN') {
            gameState.boardCards.push(gameState.deck.pop());
            console.log(`🃏 [TURN] ${gameState.boardCards[3]}`);
            emitSuccess(this.io.to(gameState.tableId), 'communityCardsDealt', 
                gameState.boardCards, 'Turn dealt');
            
            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            emitSuccess(this.io.to(gameState.tableId), 'winningProbability', probabilities, 'Probabilities updated');
        }

        if (nextPhase === 'RIVER') {
            gameState.boardCards.push(gameState.deck.pop());
            console.log(`🃏 [RIVER] ${gameState.boardCards[4]}`);
            emitSuccess(this.io.to(gameState.tableId), 'communityCardsDealt', 
                gameState.boardCards, 'River dealt');
            
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

    async formatPlayerTurnData(gameState, playerId, tableState) {
        const player = gameState.players.find(p => p.id === playerId);
        if (!player) return { playerId };

        const tablePlayer = tableState?.players.find(p => p.userId === playerId);
        const username = tablePlayer?.username || 'Player';
        const tableId = gameState.tableId;

        // 🎯 ENHANCED VALIDATION: Get available actions with private table support
        const validation = await require('../engine/poker-engine').validateAction(player, gameState, tableId);
        
        const currentBet = gameState.currentBet || 0;
        const playerBet = gameState.streetBets[playerId] || 0;
        const callAmount = Math.max(0, currentBet - playerBet);
        const betIncrement = gameState.bigBlind || 0.04;
        
        // Support both old and new validation formats
        const actions = validation.actions || {};
        const availableOptions = validation.options || Object.keys(actions).filter(key => actions[key]);
        
        // Get betting limits from validation
        const minRaiseAmount = actions.raise?.min || actions.bet?.min || validation.minRaise;
        const maxRaiseAmount = actions.raise?.max || actions.bet?.max || validation.maxRaise || player.chips;
        
        // Build raise steps based on stakes type
        const stakesType = validation.stakesType || 'NO_LIMIT';
        let raiseSteps = [];
        
        if (stakesType === 'FIXED_LIMIT') {
            // Fixed limit: only one raise amount allowed
            if (actions.raise?.exact) {
                raiseSteps = [{ label: 'Raise', value: actions.raise.exact }];
            }
        } else if (stakesType === 'POT_LIMIT') {
            // Pot limit: show pot-based raises
            const pot = gameState.pot || 0;
            raiseSteps = [
                { label: '1/2 Pot', value: Math.min(pot * 0.5, maxRaiseAmount) },
                { label: 'Pot', value: Math.min(pot, maxRaiseAmount) },
                { label: 'All-in', value: maxRaiseAmount }
            ].filter(step => step.value >= minRaiseAmount && step.value <= maxRaiseAmount);
        } else if (stakesType === 'CUSTOM') {
            // Custom: show custom increments
            const customMax = actions.raise?.max || actions.bet?.max;
            raiseSteps = [
                { label: 'Min', value: minRaiseAmount },
                { label: 'Max', value: customMax },
                { label: 'All-in', value: Math.min(customMax, player.chips) }
            ].filter(step => step.value >= minRaiseAmount && step.value <= maxRaiseAmount);
        } else {
            // No limit: standard increments
            raiseSteps = [
                { label: '2x BB', value: betIncrement * 2 },
                { label: '3x BB', value: betIncrement * 3 },
                { label: 'Pot', value: gameState.pot || 0 },
                { label: 'All-in', value: maxRaiseAmount }
            ].filter(step => step.value <= maxRaiseAmount && step.value >= minRaiseAmount);
        }

        return {
            playerId,
            username,
            availableOptions,
            callAmount: actions.call || callAmount,
            minRaiseAmount: minRaiseAmount > maxRaiseAmount ? null : minRaiseAmount,
            maxRaiseAmount: maxRaiseAmount >= minRaiseAmount ? maxRaiseAmount : null,
            raiseSteps: raiseSteps.length > 0 ? raiseSteps : null,
            betIncrement,
            stakesType,
            stakesExplanation: validation.explanation || 'Standard poker rules',
            // Additional info for UI
            bettingLimits: validation.limits || null
        };
    }

    async handleShowdown(gameState) {
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
            console.log(`💵 Player ${r.playerId} wins ${r.amount} with ${r.handName || 'High Card'}`);
        });

        // Get table state for usernames
        const tableState = await require('../table/table-manager.service').getTable(gameState.tableId);
        
        // Format winners data according to required structure
        const formattedWinners = [{
            potType: "Main Pot",
            amount: gameState.pot,
            winners: results.map(r => {
                const winner = gameState.players.find(p => p.id === r.playerId);
                const tablePlayer = tableState.players.find(p => p.userId === r.playerId);
                
                return {
                    username: tablePlayer?.username || 'Player',
                    amount: r.amount,
                    status: 'active',
                    winningHand: r.handName || 'High Card',
                    cards: {
                        holeCards: winner.cards.map(card => ({ ...card, used: true })),
                        communityCards: gameState.boardCards.map(card => ({ ...card, used: false })),
                        bestHand: r.bestHand || winner.cards
                    }
                };
            })
        }];

        // Reveal cards first
        gameState.players.filter(p => p.status !== 'FOLDED').forEach(p => {
            emitSuccess(this.io.to(gameState.tableId), 'revealPlayerCards', {
                playerId: p.id,
                hand: p.cards
            }, 'Cards revealed');
        });
        
        emitSuccess(this.io.to(gameState.tableId), 'revealingDone', {}, 'All cards revealed');
        
        // Wait 3 seconds before showing winners
        setTimeout(() => {
            emitSuccess(this.io.to(gameState.tableId), 'showdownResults', { winners: results }, 'Showdown complete');
            emitSuccess(this.io.to(gameState.tableId), 'winners', formattedWinners, 'Winners');
        }, 3000);

        console.log("🎰 Players at showdown:",
            gameState.players.map(p => ({
                id: p.id,
                status: p.status,
                cards: p.cards
            }))
        );
        
        // 🕐 CHECK FOR TIME EXPIRY: End game if time limit reached
        const tableTimerService = require('../services/table-timer.service');
        const shouldEndByTime = await tableTimerService.shouldEndAfterHand(gameState.tableId);
        
        if (shouldEndByTime) {
            console.log(`⏰ [TIME LIMIT] Game ending due to time limit after showdown`);
            emitSuccess(this.io.to(gameState.tableId), 'gameEndedByTime', {
                reason: 'TIME_LIMIT',
                message: 'Game ended due to time limit'
            }, 'Game ended by time limit');
        }
        
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
            console.log(`[DEBUG] Player ${player.userId} - gamePlayer status: ${gamePlayer?.status}`);
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
        // Format amount to show proper decimal places
        const formatAmount = (amt) => {
            if (amt === 0) return '0';
            if (amt < 1) {
                // For amounts less than 1, show up to 2 decimal places, removing trailing zeros
                return parseFloat(amt.toFixed(2)).toString();
            }
            // For amounts >= 1, show as integer if whole number, otherwise up to 2 decimals
            return amt % 1 === 0 ? amt.toString() : parseFloat(amt.toFixed(2)).toString();
        };

        switch (action) {
            case 'check':
                return `${username} checked.`;
            case 'fold':
                return `${username} folded.`;
            case 'call':
                // If call amount is 0, it should be treated as a check
                if (amount === 0) {
                    return `${username} checked.`;
                }
                return `${username} called ${formatAmount(amount)} chips.`;
            case 'raise':
                return `${username} raised to ${formatAmount(amount)} chips.`;
            case 'all-in':
                return `${username} went all-in with ${formatAmount(amount)} chips.`;
            default:
                return `${username} performed ${action}.`;
        }
    }
    
    /**
     * Check if game should end due to time expiry
     */
    async checkTimeExpiryAndEnd(gameState) {
        try {
            const tableTimerService = require('../services/table-timer.service');
            const shouldEndByTime = await tableTimerService.shouldEndAfterHand(gameState.tableId);
            
            if (shouldEndByTime) {
                console.log(`⏰ [TIME LIMIT] Game ending due to time limit`);
                emitSuccess(this.io.to(gameState.tableId), 'gameEndedByTime', {
                    reason: 'TIME_LIMIT',
                    message: 'Game ended due to time limit'
                }, 'Game ended by time limit');
                
                // Clear the timer
                tableTimerService.clearTableTimer(gameState.tableId);
            }
        } catch (error) {
            console.error('Error checking time expiry:', error);
        }
    }
}

module.exports = PlayerActionService;