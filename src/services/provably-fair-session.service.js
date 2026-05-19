const crypto = require('crypto');
const tableManager = require('../table/table-manager.service');
const mongoHelper = require('../models/customdb');
const provablyFairService = require('./provably-fair.service');

const FAIRNESS_STATUS = {
  IDLE: 'IDLE',
  AWAITING_REVEALS: 'AWAITING_REVEALS',
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED'
};

class ProvablyFairSessionService {
  log(event, payload = {}) {
    return;
  }

  formatCards(cards = []) {
    return cards.map(card => `${card.cardFace}${card.suit?.[0]?.toUpperCase?.() || ''}`);
  }

  getPlayerId(playerOrId) {
    if (!playerOrId) {
      return null;
    }

    if (typeof playerOrId === 'string') {
      return playerOrId;
    }

    return playerOrId.userId?.toString?.()
      || playerOrId.id?.toString?.()
      || playerOrId.playerId?.toString?.()
      || null;
  }

  isBotPlayer(player) {
    const userId = this.getPlayerId(player);
    return !!player?.isBot || (typeof userId === 'string' && userId.startsWith('bot_'));
  }

  ensureFairnessState(tableState) {
    if (!tableState.fairnessState) {
      tableState.fairnessState = {
        protocolVersion: 'PF_POKER_V1',
        nextCommitments: {},
        currentHand: null,
        lastCompletedHand: null
      };
    }

    if (!tableState.fairnessState.nextCommitments) {
      tableState.fairnessState.nextCommitments = {};
    }

    return tableState.fairnessState;
  }

  getEligiblePlayers(tableState) {
    return [...(tableState.players || [])]
      .filter(player => !player.disconnected && Number(player.chips || 0) > 0)
      .sort((a, b) => Number(a.seatPosition) - Number(b.seatPosition));
  }

  ensureBotCommitments(fairnessState, players) {
    players
      .filter(player => {
        const playerId = this.getPlayerId(player);
        return playerId && this.isBotPlayer(player) && !fairnessState.nextCommitments[playerId];
      })
      .forEach(player => {
        const playerId = this.getPlayerId(player);
        const clientSeed = crypto.randomBytes(32).toString('hex');
        fairnessState.nextCommitments[playerId] = {
          playerId,
          username: player.username,
          clientSeedHash: provablyFairService.sha256(clientSeed),
          clientSeed,
          isBot: true,
          committedAt: new Date().toISOString()
        };
      });
  }

  sanitizeCommitment(commitment) {
    if (!commitment) {
      return null;
    }

    return {
      playerId: commitment.playerId,
      username: commitment.username,
      clientSeedHash: commitment.clientSeedHash,
      committedAt: commitment.committedAt
    };
  }

  getPublicStateFromTable(tableState) {
    const fairnessState = this.ensureFairnessState(tableState);
    const eligiblePlayers = this.getEligiblePlayers(tableState);
    const currentHand = fairnessState.currentHand;
    const currentHandActive = currentHand && [
      FAIRNESS_STATUS.AWAITING_REVEALS,
      FAIRNESS_STATUS.READY,
      FAIRNESS_STATUS.IN_PROGRESS
    ].includes(currentHand.status);

    if (!currentHandActive) {
      this.ensureBotCommitments(fairnessState, eligiblePlayers);
    }

    return {
      protocolVersion: fairnessState.protocolVersion,
      status: currentHand?.status || FAIRNESS_STATUS.IDLE,
      nextCommitments: currentHandActive ? [] : eligiblePlayers
        .map(player => fairnessState.nextCommitments[this.getPlayerId(player)])
        .filter(Boolean)
        .map(commitment => this.sanitizeCommitment(commitment)),
      missingCommitments: currentHandActive ? [] : eligiblePlayers
        .filter(player => !fairnessState.nextCommitments[this.getPlayerId(player)])
        .map(player => ({
          playerId: this.getPlayerId(player),
          username: player.username,
          seatPosition: player.seatPosition
        })),
      currentHand: currentHand ? {
        protocolVersion: currentHand.protocolVersion,
        algorithm: currentHand.algorithm,
        tableId: currentHand.tableId,
        handNumber: currentHand.handNumber,
        status: currentHand.status,
        serverSeedHash: currentHand.serverSeedHash,
        playerSeedCommitments: currentHand.playerSeedCommitments,
        revealedPlayerIds: (currentHand.playerSeedReveals || []).map(reveal => reveal.playerId),
        pendingRevealPlayerIds: currentHand.pendingRevealPlayerIds || [],
        dealOrder: currentHand.dealOrder || [],
        drawProtocol: currentHand.drawProtocol || null,
        committedAt: currentHand.committedAt,
        readyAt: currentHand.readyAt || null,
        startedAt: currentHand.startedAt || null
      } : null,
      lastCompletedHand: fairnessState.lastCompletedHand ? {
        protocolVersion: fairnessState.lastCompletedHand.protocolVersion,
        handNumber: fairnessState.lastCompletedHand.handNumber,
        revealedAt: fairnessState.lastCompletedHand.revealedAt
      } : null
    };
  }

  async getPublicState(tableId) {
    const tableState = await tableManager.getTable(tableId);
    return this.getPublicStateFromTable(tableState);
  }

  async submitCommitment(tableId, { playerId, username, clientSeedHash }) {
    if (!/^[a-fA-F0-9]{64}$/.test(clientSeedHash || '')) {
      throw new Error('clientSeedHash must be a 64-character hex sha256 hash');
    }

    const tableState = await tableManager.getTable(tableId);
    const fairnessState = this.ensureFairnessState(tableState);
    const normalizedPlayerId = this.getPlayerId(playerId);
    fairnessState.nextCommitments[normalizedPlayerId] = {
      playerId: normalizedPlayerId,
      username,
      clientSeedHash: clientSeedHash.toLowerCase(),
      committedAt: new Date().toISOString()
    };

    await tableManager.saveTable(tableId, tableState);
    return this.getPublicStateFromTable(tableState);
  }

  async removePlayer(tableId, playerId) {
    const tableState = await tableManager.getTable(tableId);
    const fairnessState = this.ensureFairnessState(tableState);
    const normalizedPlayerId = this.getPlayerId(playerId);
    delete fairnessState.nextCommitments[normalizedPlayerId];

    if (fairnessState.currentHand) {
      fairnessState.currentHand.playerSeedCommitments = (fairnessState.currentHand.playerSeedCommitments || [])
        .filter(commitment => commitment.playerId !== normalizedPlayerId);
      fairnessState.currentHand.playerSeedReveals = (fairnessState.currentHand.playerSeedReveals || [])
        .filter(reveal => reveal.playerId !== normalizedPlayerId);
      fairnessState.currentHand.pendingRevealPlayerIds = (fairnessState.currentHand.pendingRevealPlayerIds || [])
        .filter(id => id !== normalizedPlayerId);
    }

    await tableManager.saveTable(tableId, tableState);
  }

  async prepareHand(tableId) {
    const tableState = await tableManager.getTable(tableId);
    const fairnessState = this.ensureFairnessState(tableState);
    const eligiblePlayers = this.getEligiblePlayers(tableState);
    this.ensureBotCommitments(fairnessState, eligiblePlayers);
    if (eligiblePlayers.length < 2) {
      return {
        status: 'NOT_READY',
        fairnessState: this.getPublicStateFromTable(tableState)
      };
    }

    if (fairnessState.currentHand?.status === FAIRNESS_STATUS.READY
      || fairnessState.currentHand?.status === FAIRNESS_STATUS.AWAITING_REVEALS
      || fairnessState.currentHand?.status === FAIRNESS_STATUS.IN_PROGRESS) {
      return {
        status: fairnessState.currentHand.status,
        fairnessState: this.getPublicStateFromTable(tableState)
      };
    }

    const missingCommitments = eligiblePlayers
      .filter(player => !fairnessState.nextCommitments[this.getPlayerId(player)])
      .map(player => ({
        playerId: this.getPlayerId(player),
        username: player.username,
        seatPosition: player.seatPosition
      }));

    if (missingCommitments.length > 0) {
      return {
        status: 'MISSING_COMMITMENTS',
        missingCommitments,
        fairnessState: this.getPublicStateFromTable(tableState)
      };
    }

    const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
    if (!tableDoc.success || !tableDoc.data) {
      throw new Error('Table not found while preparing fairness hand');
    }

    const handNumber = Math.max(
      Number(tableDoc.data.gameRoundsCompleted || 0),
      Number(fairnessState.lastCompletedHand?.handNumber || 0),
      Number(fairnessState.currentHand?.handNumber || 0)
    ) + 1;
    const serverCommitment = provablyFairService.createServerCommitment({
      tableId,
      handNumber,
      playerIds: eligiblePlayers.map(player => this.getPlayerId(player))
    });
    const dealOrder = provablyFairService.buildDealOrder(
      eligiblePlayers.map(player => ({
        id: player.userId,
        seatPosition: player.seatPosition
      })),
      tableState.dealerPosition
    );

    fairnessState.currentHand = {
      protocolVersion: serverCommitment.protocolVersion,
      algorithm: serverCommitment.algorithm,
      tableId: tableId.toString(),
      handNumber,
      status: FAIRNESS_STATUS.AWAITING_REVEALS,
      serverSeed: serverCommitment.serverSeed,
      serverSeedHash: serverCommitment.serverSeedHash,
      playerSeedCommitments: eligiblePlayers.map(player => ({
        playerId: this.getPlayerId(player),
        username: player.username,
        seatPosition: player.seatPosition,
        isBot: this.isBotPlayer(player),
        clientSeedHash: fairnessState.nextCommitments[this.getPlayerId(player)].clientSeedHash,
        committedAt: fairnessState.nextCommitments[this.getPlayerId(player)].committedAt
      })),
      playerSeedReveals: eligiblePlayers
        .filter(player => this.isBotPlayer(player))
        .map(player => ({
          playerId: this.getPlayerId(player),
          clientSeed: fairnessState.nextCommitments[this.getPlayerId(player)].clientSeed,
          revealedAt: new Date().toISOString()
        })),
      pendingRevealPlayerIds: eligiblePlayers
        .filter(player => !this.isBotPlayer(player))
        .map(player => this.getPlayerId(player)),
      dealOrder,
      drawProtocol: {
        holeCards: 'round_robin_two_pass',
        communityCards: 'burn_before_flop_turn_river',
        deckAccess: 'pop_from_end',
        playerOrder: 'left_of_dealer_then_clockwise'
      },
      committedAt: serverCommitment.committedAt
    };

    await tableManager.saveTable(tableId, tableState);
    if ((fairnessState.currentHand.pendingRevealPlayerIds || []).length === 0) {
      return this.finalizeCurrentHand(tableId, tableState, fairnessState);
    }

    return {
      status: FAIRNESS_STATUS.AWAITING_REVEALS,
      fairnessState: this.getPublicStateFromTable(tableState)
    };
  }

  async submitReveal(tableId, { playerId, clientSeed }) {
    if (!clientSeed || typeof clientSeed !== 'string') {
      throw new Error('clientSeed is required');
    }

    const tableState = await tableManager.getTable(tableId);
    const fairnessState = this.ensureFairnessState(tableState);
    const currentHand = fairnessState.currentHand;
    const normalizedPlayerId = this.getPlayerId(playerId);

    if (!currentHand || currentHand.status !== FAIRNESS_STATUS.AWAITING_REVEALS) {
      throw new Error('No fairness hand is awaiting seed reveals');
    }

    const commitment = (currentHand.playerSeedCommitments || [])
      .find(entry => entry.playerId === normalizedPlayerId);
    if (!commitment) {
      throw new Error('Player is not part of the current fairness hand');
    }

    const clientSeedHash = provablyFairService.sha256(clientSeed);
    if (clientSeedHash !== commitment.clientSeedHash) {
      throw new Error('clientSeed does not match the previously committed hash');
    }

    const existingReveal = (currentHand.playerSeedReveals || [])
      .find(entry => entry.playerId === normalizedPlayerId);
    if (!existingReveal) {
      currentHand.playerSeedReveals.push({
        playerId: normalizedPlayerId,
        clientSeed,
        revealedAt: new Date().toISOString()
      });
      currentHand.pendingRevealPlayerIds = (currentHand.pendingRevealPlayerIds || [])
        .filter(id => id !== normalizedPlayerId);
    }

    if ((currentHand.pendingRevealPlayerIds || []).length === 0) {
      await tableManager.saveTable(tableId, tableState);
      return this.finalizeCurrentHand(tableId, tableState, fairnessState);
    }

    await tableManager.saveTable(tableId, tableState);

    return {
      status: fairnessState.currentHand.status,
      fairnessState: this.getPublicStateFromTable(tableState)
    };
  }

  async finalizeCurrentHand(tableId, tableState, fairnessState) {
    const currentHand = fairnessState.currentHand;
    const finalized = provablyFairService.finalizeHandCommitment({
      serverCommitment: currentHand,
      reveals: currentHand.playerSeedReveals,
      dealOrder: currentHand.dealOrder
    });
    const verification = provablyFairService.verifyCommitment({
      serverSeed: finalized.serverSeed,
      serverSeedHash: finalized.serverSeedHash,
      combinedClientSeed: finalized.combinedClientSeed,
      finalSeed: finalized.finalSeed
    });

    fairnessState.currentHand = {
      ...currentHand,
      ...finalized,
      playerSeedCommitments: currentHand.playerSeedCommitments,
      status: FAIRNESS_STATUS.READY
    };

    await tableManager.saveTable(tableId, tableState);
    this.log('HAND_READY', {
      tableId,
      handNumber: fairnessState.currentHand.handNumber,
      combinedClientSeed: fairnessState.currentHand.combinedClientSeed,
      finalSeed: fairnessState.currentHand.finalSeed,
      verification,
      playerSeedReveals: fairnessState.currentHand.playerSeedReveals.map(reveal => ({
        playerId: reveal.playerId,
        clientSeedHash: reveal.clientSeedHash
      }))
    });

    return {
      status: FAIRNESS_STATUS.READY,
      fairnessState: this.getPublicStateFromTable(tableState)
    };
  }

  async consumeReadyHand(tableId) {
    const tableState = await tableManager.getTable(tableId);
    const fairnessState = this.ensureFairnessState(tableState);
    const currentHand = fairnessState.currentHand;

    if (!currentHand || currentHand.status !== FAIRNESS_STATUS.READY) {
      return null;
    }

    currentHand.status = FAIRNESS_STATUS.IN_PROGRESS;
    currentHand.startedAt = new Date().toISOString();

    (currentHand.playerSeedCommitments || []).forEach(commitment => {
      delete fairnessState.nextCommitments[commitment.playerId];
    });

    await tableManager.saveTable(tableId, tableState);
    return currentHand;
  }

  async completeHand(tableId, gameState) {
    const tableState = await tableManager.getTable(tableId);
    const fairnessState = this.ensureFairnessState(tableState);
    const currentHand = fairnessState.currentHand;

    if (!currentHand) {
      return null;
    }

    const reveal = provablyFairService.buildReveal({
      ...currentHand,
      boardCards: gameState?.boardCards || [],
      burnCards: gameState?.burnCards || []
    });
    this.log('HAND_COMPLETED', {
      tableId,
      handNumber: currentHand.handNumber,
      phase: gameState?.phase,
      pot: gameState?.pot,
      boardCards: this.formatCards(gameState?.boardCards || []),
      burnCards: (gameState?.burnCards || []).map(entry => ({
        street: entry.street,
        card: `${entry.card?.cardFace}${entry.card?.suit?.[0] || ''}`
      })),
      playerCards: (gameState?.players || []).map(player => ({
        playerId: player.id,
        username: player.username,
        cards: this.formatCards(player.cards || [])
      })),
      serverSeedHash: reveal.serverSeedHash,
      finalSeed: reveal.finalSeed,
      combinedClientSeed: reveal.combinedClientSeed
    });

    fairnessState.lastCompletedHand = reveal;
    fairnessState.currentHand = null;
    await tableManager.saveTable(tableId, tableState);

    return reveal;
  }
}

module.exports = new ProvablyFairSessionService();
