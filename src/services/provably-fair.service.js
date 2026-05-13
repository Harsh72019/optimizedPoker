const crypto = require('crypto');

const ALGORITHM = 'HMAC_SHA256_FISHER_YATES_V1';
const PROTOCOL_VERSION = 'PF_POKER_V1';
const DRAW_PROTOCOL = {
  holeCards: 'round_robin_two_pass',
  communityCards: 'burn_before_flop_turn_river',
  deckAccess: 'pop_from_end',
  playerOrder: 'left_of_dealer_then_clockwise'
};

class ProvablyFairService {
  createServerCommitment({ tableId, handNumber, playerIds = [] }) {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const serverSeedHash = this.sha256(serverSeed);

    return {
      protocolVersion: PROTOCOL_VERSION,
      algorithm: ALGORITHM,
      tableId: tableId.toString(),
      handNumber,
      serverSeed,
      serverSeedHash,
      playerIds: [...playerIds].map(playerId => playerId?.toString()).filter(Boolean),
      committedAt: new Date().toISOString()
    };
  }

  buildCombinedClientSeed({ tableId, handNumber, reveals = [] }) {
    const normalizedReveals = [...reveals]
      .map(reveal => ({
        playerId: reveal.playerId?.toString(),
        clientSeed: reveal.clientSeed
      }))
      .filter(reveal => reveal.playerId && typeof reveal.clientSeed === 'string')
      .sort((a, b) => a.playerId.localeCompare(b.playerId));

    const combinedSeedPayload = {
      protocolVersion: PROTOCOL_VERSION,
      tableId: tableId.toString(),
      handNumber,
      reveals: normalizedReveals
    };

    return {
      combinedClientSeed: this.sha256(JSON.stringify(combinedSeedPayload)),
      normalizedReveals
    };
  }

  finalizeHandCommitment({ serverCommitment, reveals = [], dealOrder = [] }) {
    const { combinedClientSeed, normalizedReveals } = this.buildCombinedClientSeed({
      tableId: serverCommitment.tableId,
      handNumber: serverCommitment.handNumber,
      reveals
    });
    const finalSeed = crypto
      .createHmac('sha256', serverCommitment.serverSeed)
      .update(combinedClientSeed)
      .digest('hex');

    return {
      protocolVersion: PROTOCOL_VERSION,
      algorithm: serverCommitment.algorithm,
      tableId: serverCommitment.tableId,
      handNumber: serverCommitment.handNumber,
      serverSeed: serverCommitment.serverSeed,
      serverSeedHash: serverCommitment.serverSeedHash,
      playerSeedReveals: normalizedReveals.map(reveal => ({
        ...reveal,
        clientSeedHash: this.sha256(reveal.clientSeed)
      })),
      combinedClientSeed,
      finalSeed,
      committedAt: serverCommitment.committedAt,
      readyAt: new Date().toISOString(),
      dealOrder: [...dealOrder],
      drawProtocol: { ...DRAW_PROTOCOL }
    };
  }

  buildPublicCommitment(commitment) {
    return {
      protocolVersion: commitment.protocolVersion || PROTOCOL_VERSION,
      algorithm: commitment.algorithm,
      tableId: commitment.tableId,
      handNumber: commitment.handNumber,
      serverSeedHash: commitment.serverSeedHash,
      playerSeedCommitments: commitment.playerSeedCommitments || [],
      dealOrder: commitment.dealOrder || [],
      drawProtocol: commitment.drawProtocol || { ...DRAW_PROTOCOL },
      committedAt: commitment.committedAt,
      readyAt: commitment.readyAt || null
    };
  }

  buildReveal(commitment) {
    return {
      ...this.buildPublicCommitment(commitment),
      serverSeed: commitment.serverSeed,
      playerSeedReveals: commitment.playerSeedReveals || [],
      combinedClientSeed: commitment.combinedClientSeed,
      finalSeed: commitment.finalSeed,
      revealedAt: new Date().toISOString()
    };
  }

  verifyCommitment({ serverSeed, serverSeedHash, combinedClientSeed, finalSeed }) {
    const derivedHash = this.sha256(serverSeed);
    const derivedFinalSeed = crypto
      .createHmac('sha256', serverSeed)
      .update(combinedClientSeed)
      .digest('hex');

    return {
      validServerSeed: derivedHash === serverSeedHash,
      validFinalSeed: derivedFinalSeed === finalSeed,
      derivedHash,
      derivedFinalSeed
    };
  }

  buildDealOrder(players = [], dealerPosition = null) {
    const activePlayers = [...players]
      .filter(player => player?.id && Number(player?.seatPosition) > 0)
      .sort((a, b) => Number(a.seatPosition) - Number(b.seatPosition));

    if (activePlayers.length === 0) {
      return [];
    }

    const dealerIndex = activePlayers.findIndex(
      player => Number(player.seatPosition) === Number(dealerPosition)
    );
    const startIndex = dealerIndex >= 0
      ? (dealerIndex + 1) % activePlayers.length
      : 0;

    return [
      ...activePlayers.slice(startIndex),
      ...activePlayers.slice(0, startIndex)
    ].map(player => ({
      playerId: player.id.toString(),
      seatPosition: Number(player.seatPosition)
    }));
  }

  dealHoleCards({ deck, players = [], dealerPosition = null }) {
    const order = this.buildDealOrder(players, dealerPosition);
    const playerMap = new Map(players.map(player => [player.id.toString(), player]));

    order.forEach(({ playerId }) => {
      const player = playerMap.get(playerId);
      if (player) {
        player.cards = [];
      }
    });

    for (let round = 0; round < 2; round++) {
      order.forEach(({ playerId }) => {
        const player = playerMap.get(playerId);
        if (!player) {
          return;
        }

        player.cards.push(deck.pop());
      });
    }

    return order;
  }

  burnCard(gameState, street) {
    if (!Array.isArray(gameState.burnCards)) {
      gameState.burnCards = [];
    }

    const card = gameState.deck.pop();
    if (!card) {
      return null;
    }

    gameState.burnCards.push({
      street,
      card
    });

    return card;
  }

  sha256(value) {
    return crypto
      .createHash('sha256')
      .update(value)
      .digest('hex');
  }
}

module.exports = new ProvablyFairService();
