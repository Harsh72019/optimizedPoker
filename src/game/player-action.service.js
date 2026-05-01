// src/game/player-action.service.js

const gameStateManager = require('../state/game-state');
const PokerEngine = require('../engine/poker-engine');
const GameStateMachine = require('../engine/game-state-machine');
const gameQueue = require('../queues/game-queue');
const ProbabilityCalculator = require('./probability-calculator');
const { emitSuccess } = require('../websocket/socket-emitter');
const privateTableGameConfig = require('../services/private-table-game-config.service');
class PlayerActionService {
    constructor(io, timerManager, orchestrator) {
        this.io = io;
        this.timerManager = timerManager;
        this.orchestrator = orchestrator;
    }

    normalizeAmount(value) {
        const amount = Number(value || 0);
        if (!Number.isFinite(amount)) {
            return 0;
        }

        const normalized = Math.round((amount + Number.EPSILON) * 100) / 100;
        return Math.abs(normalized) < 0.000001 ? 0 : normalized;
    }

    async forceEndHand(tableId) {
        const gameState = await gameStateManager.getGame(tableId);

        gameState.currentPlayerId = null;
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
            } else {
                this.timerManager.clearTimer(tableId);
            }

            let tableState = await require('../table/table-manager.service').getTable(tableId);
            const actingPlayer = tableState.players.find(p => p.userId === normalizedPlayerId);
            const actionPolicy = await this.getActionPolicy(tableId, normalizedPlayerId, gameState, tableState);

            this.validateActionRequest(action, amount, actionPolicy);

            const actionAmount = action === 'all-in'
                ? this.normalizeAmount(player.chips)
                : this.normalizeAmount(action === 'call' ? actionPolicy.callAmount || 0 : amount);

            this.applyAction(gameState, player, action, amount, actionPolicy);
            console.log(`✅ [ACTION APPLIED] ${action} by ${playerId}`);

            // Emit specific action events
            if (action === 'fold') {
                const tableState = await require('../table/table-manager.service').getTable(tableId);
                const formattedData = this.formatTableData(tableState, gameState);
                emitSuccess(this.io.to(tableId), 'playerFolded', formattedData, 'Player folded');
            } else if (action === 'all-in') {
                emitSuccess(
                    this.io.to(tableId),
                    'playerAllIn',
                    { playerId, amount: actionAmount },
                    'Player all-in'
                );
            }

            const actionData = {
                playerId: normalizedPlayerId,
                username: actingPlayer?.username || 'Player',
                action,
                amount: actionAmount,
                result: true,
                timestamp: new Date().toISOString()
            };

            emitSuccess(this.io.to(tableId), 'actionTaken', actionData, this.getActionMessage(action, actionData.username, actionData.amount));
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
            await require('../table/table-manager.service').syncFromGameState(tableId, gameState);
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

            if (gameState.phase !== 'COMPLETED' && gameState.phase !== 'SHOWDOWN' && gameState.currentPlayerId) {
                this.timerManager.startTimer(tableId, gameState.currentPlayerId, this.getTurnTimerSeconds(gameState));
            } else if (gameState.phase === 'COMPLETED') {
                console.log(`🏁 [HAND COMPLETE] Starting cleanup`);
                this.timerManager.clearTimer(tableId);

                await require('../table/table-manager.service').syncFromGameState(tableId, gameState);
                await this.orchestrator.onHandCompleted(tableId);
                console.log(`✅ [CLEANUP DONE]`);
            }
            else {
                this.timerManager.clearTimer(tableId);
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

    applyAction(gameState, player, action, amount, policy) {
        const callAmount = this.normalizeAmount(policy.callAmount || 0);

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
            case 'bet':
                this.applyBet(gameState, player, this.normalizeAmount(amount));
                // gameState.currentBet = player.chipsInPot;

                gameState.players.forEach(p => {
                    if (p.id !== player.id && p.status === 'ACTIVE') {
                        p.hasActed = false;
                    }
                });
                break;

            case 'all-in':
                this.applyBet(gameState, player, this.normalizeAmount(player.chips));
                player.status = 'ALL_IN';
                break;
        }

        if (player.status === 'ACTIVE' && this.normalizeAmount(player.chips) === 0) {
            player.status = 'ALL_IN';
        }

        player.hasActed = true;
    }

    applyBet(gameState, player, amount) {
        const actual = this.normalizeAmount(Math.min(amount, player.chips));

        player.chips = this.normalizeAmount(player.chips - actual);

        gameState.streetBets[player.id] = this.normalizeAmount((gameState.streetBets[player.id] || 0) + actual);
        gameState.totalContributions[player.id] = this.normalizeAmount((gameState.totalContributions[player.id] || 0) + actual);

        // If raise
        if (this.normalizeAmount(gameState.streetBets[player.id]) > this.normalizeAmount(gameState.currentBet)) {
            const raiseSize = this.normalizeAmount(
                gameState.streetBets[player.id] - gameState.currentBet
            );

            gameState.lastRaiseAmount = raiseSize;
            gameState.currentBet = this.normalizeAmount(gameState.streetBets[player.id]);

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
                this.normalizeAmount(p.chips) > 0
            )
            .sort((a, b) => a.seatPosition - b.seatPosition);

        // Edge case: No active players left
        if (active.length === 0) {
            console.log('⚠️ [NO ACTIVE PLAYERS] Moving to showdown');
            gameState.currentPlayerId = null;
            this.moveToNextPhase(gameState);
            return;
        }
        // If exactly one player can still act, give them the turn.
        if (active.length === 1) {
            console.log(`[SINGLE ACTIVE PLAYER] Next to act: ${active[0].id}`);
            gameState.currentPlayerId = active[0].id;
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

    async animateRunoutAndShowdown(gameState) {
        if (gameState.phase === 'COMPLETED') {
            return;
        }

        gameState.phase = 'SHOWDOWN';
        emitSuccess(this.io.to(gameState.tableId), 'newPhase', { phase: 'SHOWDOWN' }, 'SHOWDOWN phase started');

        const delayMs = 800;

        while (gameState.boardCards.length < 5) {
            const nextCard = gameState.deck.pop();
            if (!nextCard) {
                break;
            }

            gameState.boardCards.push(nextCard);

            emitSuccess(
                this.io.to(gameState.tableId),
                'communityCardsDealt',
                gameState.boardCards,
                'Runout card dealt'
            );

            const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
            if (probabilities.length > 0) {
                emitSuccess(this.io.to(gameState.tableId), 'winningProbability', probabilities, 'Probabilities updated');
            }

            await gameStateManager.updateGame(gameState.tableId, gameState);
            await require('../table/table-manager.service').syncFromGameState(gameState.tableId, gameState);

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        await this.handleShowdown(gameState);
        await gameStateManager.updateGame(gameState.tableId, gameState);
        await require('../table/table-manager.service').syncFromGameState(gameState.tableId, gameState);
        this.timerManager.clearTimer(gameState.tableId);
        await this.orchestrator.onHandCompleted(gameState.tableId);
    }

    moveToNextPhase(gameState) {
        if (gameState.phase === 'COMPLETED') return;

        for (const id in gameState.streetBets) {
            gameState.pot = this.normalizeAmount(gameState.pot + gameState.streetBets[id]);
            gameState.streetBets[id] = 0;
        }

        const activePlayers = gameState.players.filter(p => p.status !== 'FOLDED');

        if (activePlayers.length === 1) {
            console.log(`🏆 [WINNER] ${activePlayers[0].id} wins by fold`);
            const winner = activePlayers[0];
            const winAmount = this.normalizeAmount(gameState.pot);
            winner.chips = this.normalizeAmount(winner.chips + winAmount);
            gameState.pot = 0;
            gameState.currentPlayerId = null;
            gameState.phase = 'COMPLETED';
            const formattedWinners = [{
                potType: "Main Pot",
                amount: winAmount,
                winners: [{
                    username: winner.username || 'Player',
                    amount: winAmount,
                    status: 'active',
                    winningHand: 'Win by Fold',
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
            gameState.currentPlayerId = null;
            this.animateRunoutAndShowdown(gameState).catch(error => {
                console.error(`âŒ [ALL-IN RUNOUT] Failed for table ${gameState.tableId}:`, error);
            });
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
            gameState.currentPlayerId = null;
            this.handleShowdown(gameState);
            return;
        }

        gameState.currentBet = 0;
        gameState.players.forEach(p => { p.hasActed = false; });
        gameState.currentPlayerId = this.getFirstAfterDealer(gameState);
        
        // Edge case: No active player to act
        if (!gameState.currentPlayerId) {
            console.log('⚠️ [NO PLAYER TO ACT] Moving to showdown');
            gameState.currentPlayerId = null;
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
        const policy = await this.getActionPolicy(gameState.tableId, playerId, gameState, tableState);

        return {
            playerId,
            username,
            availableOptions: policy.availableOptions,
            callAmount: policy.callAmount,
            minRaiseAmount: policy.minRaiseAmount,
            maxRaiseAmount: policy.maxRaiseAmount,
            raiseSteps: policy.raiseSteps,
            betIncrement: policy.betIncrement,
            stakes: policy.stakes,
            timer: policy.timer,
            tableDuration: policy.tableDuration
        };
    }

    async getActionPolicy(tableId, playerId, gameState, tableState = null) {
        const player = gameState.players.find(p => p.id === playerId);
        if (!player) {
            throw new Error('Player not found in game state');
        }

        const privateConfig =
            gameState.privateTableConfig ||
            (await privateTableGameConfig.getPrivateTableGameConfig(tableId))?.gameConfig ||
            null;

        return privateConfig
            ? this.buildPrivateActionPolicy(privateConfig, player, gameState)
            : this.buildRegularActionPolicy(player, gameState);
    }

    buildRegularActionPolicy(player, gameState) {
        const validation = PokerEngine.validateAction(player, gameState);
        const availableOptions = validation.options || [];
        const minRaiseAmount = validation.minRaiseAmount ?? validation.minRaise ?? null;
        const maxRaiseAmount = validation.maxRaiseAmount ?? validation.maxRaise ?? null;

        return {
            availableOptions,
            callAmount: validation.callAmount || 0,
            minRaiseAmount,
            maxRaiseAmount,
            raiseSteps: availableOptions.includes('raise')
                ? this.buildRaiseSteps(minRaiseAmount, maxRaiseAmount, gameState)
                : null,
            betIncrement: gameState.bigBlind || 0
        };
    }

    buildPrivateActionPolicy(privateConfig, player, gameState) {
        const regularPolicy = this.buildRegularActionPolicy(player, gameState);
        const hasRaise = regularPolicy.availableOptions.includes('raise');
        const privateRaisePolicy = hasRaise
            ? this.getPrivateRaisePolicy(privateConfig, player, gameState, regularPolicy)
            : { minRaiseAmount: null, maxRaiseAmount: null };

        return {
            ...regularPolicy,
            minRaiseAmount: hasRaise ? privateRaisePolicy.minRaiseAmount : null,
            maxRaiseAmount: hasRaise ? privateRaisePolicy.maxRaiseAmount : null,
            raiseSteps: hasRaise
                ? this.buildRaiseSteps(privateRaisePolicy.minRaiseAmount, privateRaisePolicy.maxRaiseAmount, gameState)
                : null,
            betIncrement: privateConfig.blinds?.big || gameState.bigBlind || 0,
            stakes: privateConfig.stakes?.type || 'NO_LIMIT',
            timer: privateConfig.timer,
            tableDuration: privateConfig.duration
        };
    }

    getPrivateRaisePolicy(privateConfig, player, gameState, regularPolicy) {
        const currentBet = gameState.currentBet || 0;
        const playerBet = gameState.streetBets[player.id] || 0;
        const callAmount = Math.max(0, currentBet - playerBet);
        const tableMaxRaise = regularPolicy.maxRaiseAmount ?? (player.chips + playerBet);
        const lastRaiseAmount = gameState.lastRaiseAmount || privateConfig.blinds?.big || gameState.bigBlind || 0;
        let minRaiseAmount = regularPolicy.minRaiseAmount ?? null;
        let maxRaiseAmount = tableMaxRaise;

        switch (privateConfig.stakes?.type) {
            case 'FIXED_LIMIT': {
                minRaiseAmount = privateConfig.stakes?.fixedLimitRules?.minRaise ?? regularPolicy.minRaiseAmount;
                maxRaiseAmount = privateConfig.stakes?.fixedLimitRules?.maxRaise ?? minRaiseAmount;
                break;
            }
            case 'POT_LIMIT': {
                minRaiseAmount = currentBet === 0
                    ? (privateConfig.stakes?.bigBlind || gameState.bigBlind || 0)
                    : currentBet + Math.max(lastRaiseAmount, privateConfig.stakes?.bigBlind || gameState.bigBlind || 0);
                const potSizedRaiseTo = currentBet + callAmount + (gameState.pot || 0);
                maxRaiseAmount = Math.min(tableMaxRaise, potSizedRaiseTo);
                break;
            }
            case 'CUSTOM': {
                const customMin = privateConfig.stakes?.customRules?.minRaise || regularPolicy.minRaiseAmount || 0;
                const customMax = privateConfig.stakes?.customRules?.maxRaise || tableMaxRaise;
                minRaiseAmount = customMin;
                maxRaiseAmount = Math.min(tableMaxRaise, customMax);
                break;
            }
            case 'NO_LIMIT':
            default: {
                minRaiseAmount = regularPolicy.minRaiseAmount;
                maxRaiseAmount = tableMaxRaise;
                break;
            }
        }

        if (maxRaiseAmount < minRaiseAmount) {
            maxRaiseAmount = minRaiseAmount;
        }

        return { minRaiseAmount, maxRaiseAmount };
    }

    buildRaiseSteps(minRaiseAmount, maxRaiseAmount, gameState) {
        if (minRaiseAmount == null || maxRaiseAmount == null || maxRaiseAmount < minRaiseAmount) {
            return null;
        }

        const candidates = [
            { label: 'Min', value: minRaiseAmount },
            { label: '2x BB', value: Math.max(minRaiseAmount, (gameState.bigBlind || 0) * 2) },
            { label: '3x BB', value: Math.max(minRaiseAmount, (gameState.bigBlind || 0) * 3) },
            { label: 'Pot', value: Math.max(minRaiseAmount, gameState.pot || 0) },
            { label: 'All-in', value: maxRaiseAmount }
        ];

        const seen = new Set();
        const steps = [];

        for (const step of candidates) {
            const value = Math.min(maxRaiseAmount, step.value);
            if (value < minRaiseAmount || seen.has(value)) {
                continue;
            }

            seen.add(value);
            steps.push({ label: step.label, value });
        }

        return steps.length > 0 ? steps : null;
    }

    validateActionRequest(action, amount, policy) {
        if (!policy.availableOptions.includes(action)) {
            throw new Error('Invalid action');
        }

        if ((action === 'raise' || action === 'bet') && policy.minRaiseAmount != null) {
            const normalizedAmount = this.normalizeAmount(amount);

            if (typeof amount !== 'number' || Number.isNaN(amount)) {
                throw new Error('Raise amount is required');
            }

            if (normalizedAmount < this.normalizeAmount(policy.minRaiseAmount)) {
                throw new Error(`Raise must be at least ${policy.minRaiseAmount}`);
            }

            if (policy.maxRaiseAmount != null && normalizedAmount > this.normalizeAmount(policy.maxRaiseAmount)) {
                throw new Error(`Raise cannot exceed ${policy.maxRaiseAmount}`);
            }
        }
    }

    async handleShowdown(gameState) {
        for (const id in gameState.streetBets) {
            gameState.pot = this.normalizeAmount(gameState.pot + gameState.streetBets[id]);
            gameState.streetBets[id] = 0;
        }

        console.log(`💰 [SHOWDOWN] Pot: ${gameState.pot}`);
        console.log(`💰 [CONTRIBUTIONS]`, gameState.totalContributions);
        
        const results = PokerEngine.evaluateShowdown(gameState);
        console.log(`💰 [SHOWDOWN RESULTS] ${results.length} winner(s)`);

        results.forEach(r => {
            const winner = gameState.players.find(p => p.id === r.playerId);
            winner.chips = this.normalizeAmount(winner.chips + r.amount);
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
                    username: tablePlayer?.username || winner?.username || 'Player',
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

    getTurnTimerSeconds(gameState) {
        return gameState?.privateTableConfig?.timer?.turnTimer || gameState?.tournamentConfig?.turnTimer || 20;
    }

    formatTableData(tableState, gameState) {
        const formattedPlayers = tableState.players.map(player => {
            const gamePlayer = gameState?.players.find(p => p.id === player.userId);
            console.log(`[DEBUG] Player ${player.userId} - gamePlayer status: ${gamePlayer?.status}`);
            return {
                _id: player.userId,
                username: player.username,
                chips: this.normalizeAmount(player.chips),
                seatPosition: player.seatPosition,
                status: gamePlayer?.status || 'waiting',
                socketId: player.socketId,
                isAway: player.isAway || false,
                currentRoundBet: gameState ? this.normalizeAmount(gameState.streetBets[player.userId] || 0) : 0
            };
        });

        return {
            maxPlayers: tableState.maxPlayers || 9,
            currentPlayers: formattedPlayers,
            gameState: gameState ? {
                pot: this.normalizeAmount(gameState.pot || 0),
                phase: gameState.phase,
                currentPlayerId: gameState.currentPlayerId,
                currentBet: this.normalizeAmount(gameState.currentBet || 0),
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
}

module.exports = PlayerActionService;
