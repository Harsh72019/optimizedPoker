const mongoHelper = require('../models/customdb');
const tableManager = require('../table/table-manager.service');
const gameStateManager = require('../state/game-state');
const walletIntegrationService = require('./wallet-integration.service');
const { emitSuccess } = require('../websocket/socket-emitter');
const {
  dummyTournament,
  DUMMY_TOURNAMENT_ID,
  matchesTournamentFilters,
} = require('../fixtures/dummy-tournament.fixture');

class TournamentGameService {
  constructor() {
    this.defaultBlindLevels = [
      { levelNumber: 1, smallBlind: 50, bigBlind: 100, ante: 0, duration: 15 },
      { levelNumber: 2, smallBlind: 75, bigBlind: 150, ante: 0, duration: 15 },
      { levelNumber: 3, smallBlind: 100, bigBlind: 200, ante: 25, duration: 15 },
      { levelNumber: 4, smallBlind: 150, bigBlind: 300, ante: 25, duration: 15 },
      { levelNumber: 5, smallBlind: 200, bigBlind: 400, ante: 50, duration: 15 },
    ];
  }

  normalizeAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return 0;
    return Math.round((amount + Number.EPSILON) * 1000000) / 1000000;
  }

  floorToCents(value) {
    return Math.floor((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  toId(value) {
    return value?._id?.toString?.() || value?.toString?.() || value;
  }

  async createTournament(config, adminId = null) {
    const blindLevels = this.normalizeBlindLevels(config.blindLevels || config.generatedBlindLevels);
    const firstLevel = blindLevels[0];
    const rakePercentage = Number(config.rakePercentage ?? config.tierRake ?? 6);

    this.validatePayoutStructure(config.payoutStructure || [{ position: 1, percentage: 100 }]);
    this.validateScheduledTournamentRake(rakePercentage);

    const createResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      {
        name: config.name,
        description: config.description || '',
        startTime: new Date(config.startTime),
        registrationDeadline: new Date(config.registrationDeadline || config.startTime),
        templateId: config.templateId || undefined,
        status: 'registering',
        maxPlayers: Number(config.maxPlayers || 90),
        minPlayersPerTable: Number(config.minPlayersPerTable || 2),
        maxPlayersPerTable: Number(config.maxPlayersPerTable || 9),
        buyIn: Number(config.buyIn),
        currentLevel: {
          levelNumber: firstLevel.levelNumber,
          smallBlind: firstLevel.smallBlind,
          bigBlind: firstLevel.bigBlind,
          ante: firstLevel.ante || 0,
          startedAt: new Date(config.startTime),
        },
        levelStartTime: new Date(config.startTime),
        payoutStructure: config.payoutStructure || [{ position: 1, percentage: 100 }],
        players: [],
        waitlist: [],
        activeTables: [],
        underlyingTables: [],
        prizePool: 0,
        winners: [],
        levelDuration: Number(config.levelDuration || firstLevel.duration || 15),
        tournamentDuration: Number(config.tournamentDuration || 0),
        timeZone: config.timeZone || 'UTC',
        generatedBlindLevels: blindLevels,
        startingChips: Number(config.startingChips || 10000),
        isOfficial: config.isOfficial !== false,
        isPrivate: false,
        createdBy: adminId,
        rakePercentage,
        nextEliminationPosition: 0,
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!createResult.success) {
      throw new Error(createResult.error || 'Failed to create tournament');
    }

    return createResult.data;
  }

  normalizeBlindLevels(levels = []) {
    const source = Array.isArray(levels) && levels.length > 0 ? levels : this.defaultBlindLevels;
    return source.map((level, index) => ({
      levelNumber: Number(level.levelNumber || level.level || index + 1),
      smallBlind: Number(level.smallBlind),
      bigBlind: Number(level.bigBlind || Number(level.smallBlind) * 2),
      ante: Number(level.ante || 0),
      duration: Number(level.duration || level.levelDuration || 15),
    }));
  }

  validateScheduledTournamentRake(rakePercentage) {
    if (rakePercentage < 5 || rakePercentage > 8) {
      throw new Error('Scheduled tournament rake must be between 5% and 8%');
    }
  }

  validatePayoutStructure(payoutStructure) {
    const total = payoutStructure.reduce((sum, row) => sum + Number(row.percentage || 0), 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new Error('Payout structure must total 100%');
    }
  }

  async listTournaments(filters = {}) {
    const query = { isPrivate: false };
    if (filters.status) query.status = filters.status;
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENTS, query);
    if (!result.success) throw new Error(result.error || 'Failed to list tournaments');

    const tournaments = result.data || [];
    if (tournaments.length === 0 && matchesTournamentFilters(filters)) {
      tournaments.push(dummyTournament);
    }

    return tournaments.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  }

  async getTournament(tournamentId) {
    if (tournamentId === DUMMY_TOURNAMENT_ID) {
      return dummyTournament;
    }

    const result = await mongoHelper.findById(mongoHelper.COLLECTIONS.TOURNAMENTS, tournamentId);
    if (!result.success || !result.data) {
      throw new Error('Tournament not found');
    }
    return result.data;
  }

  async registerPlayer(tournamentId, userId) {
    if (tournamentId === DUMMY_TOURNAMENT_ID) {
      throw new Error('Dummy tournament is read-only. Create a real tournament to test registration.');
    }

    const tournament = await this.getTournament(tournamentId);
    if (tournament.status !== 'registering' && tournament.status !== 'scheduled') {
      throw new Error('Registration is not open for this tournament');
    }
    if (new Date() > new Date(tournament.registrationDeadline)) {
      throw new Error('Registration deadline has passed');
    }

    const existing = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
      user: userId,
    });
    if (existing.success && existing.data?.length > 0) {
      return existing.data[0];
    }

    const registeredCount = (tournament.players || []).length;
    if (registeredCount >= Number(tournament.maxPlayers || 0)) {
      throw new Error('Tournament is full');
    }

    const walletResult = await walletIntegrationService.chargeBuyIn(userId, Number(tournament.buyIn), tournamentId);
    const bigBlind = Number(tournament.currentLevel?.bigBlind || 1);
    const playerResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
      {
        tournament: tournamentId,
        user: userId,
        seatPosition: 0,
        status: 'registered',
        chipsInPlay: Number(tournament.startingChips || 10000),
        bigBlindsAvailable: Number(tournament.startingChips || 10000) / bigBlind,
        buyInDetails: {
          amount: Number(tournament.buyIn),
          transactionId: walletResult.transactionId,
          timestamp: new Date(),
        },
        isPresent: false,
      },
      mongoHelper.MODELS.TOURNAMENT_PLAYER
    );

    if (!playerResult.success) {
      throw new Error(playerResult.error || 'Failed to register player');
    }

    const players = [...(tournament.players || []), playerResult.data._id];
    const update = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        players,
        prizePool: this.calculatePrizePool(Number(tournament.buyIn), players.length, Number(tournament.rakePercentage || 0)).prizePool,
      },
      mongoHelper.MODELS.TOURNAMENT
    );
    if (!update.success) throw new Error(update.error || 'Failed to update tournament registration');

    return playerResult.data;
  }

  async unregisterPlayer(tournamentId, userId) {
    if (tournamentId === DUMMY_TOURNAMENT_ID) {
      throw new Error('Dummy tournament is read-only. Create a real tournament to test unregistration.');
    }

    const tournament = await this.getTournament(tournamentId);
    if (!['registering', 'scheduled'].includes(tournament.status)) {
      throw new Error('Cannot unregister from a tournament that has already started');
    }

    const existing = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
      user: userId,
    });
    const tournamentPlayer = existing.success ? existing.data?.[0] : null;
    if (!tournamentPlayer) {
      throw new Error('Registration not found');
    }

    const refundResults = await walletIntegrationService.refundBuyIns([userId], Number(tournament.buyIn), tournamentId);
    const remainingPlayers = (tournament.players || []).filter(
      playerId => this.toId(playerId) !== this.toId(tournamentPlayer._id)
    );

    const deleteResult = await mongoHelper.deleteById(
      mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
      tournamentPlayer._id
    );
    if (!deleteResult.success) {
      throw new Error(deleteResult.error || 'Failed to remove tournament registration');
    }

    const financials = this.calculatePrizePool(
      Number(tournament.buyIn),
      remainingPlayers.length,
      Number(tournament.rakePercentage || 0)
    );
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        players: remainingPlayers,
        prizePool: financials.prizePool,
        roundingRemainder: financials.roundingRemainder,
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    return {
      unregistered: true,
      refundResults,
      currentRegistrations: remainingPlayers.length,
    };
  }

  calculatePrizePool(buyIn, participantCount, rakePercentage) {
    const totalBuyIns = this.normalizeAmount(buyIn * participantCount);
    const rake = this.floorToCents(totalBuyIns * (rakePercentage / 100));
    const prizePool = this.floorToCents(totalBuyIns - rake);
    const roundingRemainder = this.normalizeAmount(totalBuyIns - rake - prizePool);
    return { totalBuyIns, rake, prizePool, roundingRemainder };
  }

  async startTournament(tournamentId, io = null, startedBy = null) {
    if (tournamentId === DUMMY_TOURNAMENT_ID) {
      throw new Error('Dummy tournament is read-only. Create a real tournament to test start flow.');
    }

    const tournament = await this.getTournament(tournamentId);
    if (!['registering', 'scheduled'].includes(tournament.status)) {
      throw new Error(`Tournament cannot be started from status ${tournament.status}`);
    }

    const playerResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
    });
    if (!playerResult.success) throw new Error(playerResult.error || 'Failed to load tournament players');

    const players = (playerResult.data || []).filter(player => ['registered', 'waiting'].includes(player.status));
    if (players.length < Number(tournament.minPlayersPerTable || 2)) {
      throw new Error(`Insufficient players. Minimum required: ${tournament.minPlayersPerTable || 2}`);
    }

    const groups = this.distributePlayers(players, Number(tournament.maxPlayersPerTable || 9));
    const createdTables = [];

    for (let index = 0; index < groups.length; index += 1) {
      const tableNumber = index + 1;
      const group = groups[index];

      const tableRecord = await mongoHelper.create(
        mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
        {
          tournamentId,
          tableNumber,
          maxPlayers: Number(tournament.maxPlayersPerTable || 9),
          currentPlayers: group.map(player => player._id),
          players: group.map((player, seatIndex) => ({
            tournamentPlayerId: player._id,
            userId: player.user,
            seatPosition: seatIndex + 1,
            chips: Number(player.chipsInPlay || tournament.startingChips || 10000),
            status: 'ACTIVE',
          })),
          blindLevel: tournament.currentLevel,
          status: 'ACTIVE',
          isActive: true,
          isFinalTable: groups.length === 1,
        },
        mongoHelper.MODELS.TOURNAMENT_TABLES
      );
      if (!tableRecord.success) throw new Error(tableRecord.error || 'Failed to create tournament table');

      const underlying = await mongoHelper.create(
        mongoHelper.COLLECTIONS.TABLES,
        {
          maxPlayers: Number(tournament.maxPlayersPerTable || 9),
          currentPlayers: [],
          gameRoundsCompleted: 0,
          dealerPosition: null,
          currentTurnPosition: null,
          smallBlindPosition: null,
          bigBlindPosition: null,
          status: 'in-use',
          isTournament: true,
          tournamentId,
          tournamentTableId: tableRecord.data._id,
          tournamentTableNumber: tableNumber,
          tournamentConfig: {
            currentLevel: tournament.currentLevel,
            turnTimer: Number(tournament.timerSeconds || 20),
            startingChips: Number(tournament.startingChips || 10000),
          },
        },
        mongoHelper.MODELS.TABLE
      );
      if (!underlying.success) throw new Error(underlying.error || 'Failed to create game table');

      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
        tableRecord.data._id,
        { tableId: underlying.data._id },
        mongoHelper.MODELS.TOURNAMENT_TABLES
      );

      for (let seatIndex = 0; seatIndex < group.length; seatIndex += 1) {
        await mongoHelper.updateById(
          mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
          group[seatIndex]._id,
          {
            status: 'active',
            tableId: tableRecord.data._id,
            seatPosition: seatIndex + 1,
          },
          mongoHelper.MODELS.TOURNAMENT_PLAYER
        );
      }

      createdTables.push({
        tableId: underlying.data._id,
        tournamentTableId: tableRecord.data._id,
        tableNumber,
        status: 'ACTIVE',
        isFinalTable: groups.length === 1,
        players: group.map(player => this.toId(player.user)),
      });
    }

    const financials = this.calculatePrizePool(
      Number(tournament.buyIn),
      players.length,
      Number(tournament.rakePercentage || 0)
    );

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        status: 'active',
        startedAt: new Date(),
        startedBy,
        activeTables: createdTables.map(table => table.tournamentTableId),
        underlyingTables: createdTables.map(({ players: _players, ...table }) => table),
        prizePool: financials.prizePool,
        nextEliminationPosition: players.length,
        roundingRemainder: financials.roundingRemainder,
      },
      mongoHelper.MODELS.TOURNAMENT
    );
    if (!updateResult.success) throw new Error(updateResult.error || 'Failed to activate tournament');

    if (io) {
      for (const table of createdTables) {
        for (const userId of table.players) {
          emitSuccess(io.to(`user_${userId}`), 'redirectToTournamentTable', {
            tournamentId,
            tableId: table.tableId,
            tableNumber: table.tableNumber,
          }, 'Tournament table assigned');
        }
      }
    }

    return {
      tournament: updateResult.data,
      tables: createdTables,
      financials,
    };
  }

  distributePlayers(players, maxPlayersPerTable) {
    const tableCount = Math.ceil(players.length / maxPlayersPerTable);
    const groups = Array.from({ length: tableCount }, () => []);
    players.forEach((player, index) => {
      groups[index % tableCount].push(player);
    });
    return groups;
  }

  async getPlayerTableAssignment(tournamentId, userId) {
    const playerResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
      user: userId,
    });
    const tournamentPlayer = playerResult.success ? playerResult.data?.[0] : null;
    if (!tournamentPlayer) throw new Error('Player is not registered for this tournament');
    if (!tournamentPlayer.tableId) throw new Error('Tournament table is not assigned yet');

    const tournamentTable = await mongoHelper.findById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
      tournamentPlayer.tableId
    );
    if (!tournamentTable.success || !tournamentTable.data?.tableId) {
      throw new Error('Tournament table is not ready');
    }

    return {
      tournamentId,
      tournamentPlayerId: tournamentPlayer._id,
      tournamentTableId: tournamentPlayer.tableId,
      tableId: tournamentTable.data.tableId,
      tableNumber: tournamentTable.data.tableNumber,
      seatPosition: tournamentPlayer.seatPosition,
      chips: Number(tournamentPlayer.chipsInPlay || 0),
      status: tournamentPlayer.status,
    };
  }

  async buildTournamentSeat(tableId, tournamentId, userId, socketId, username) {
    const assignment = await this.getPlayerTableAssignment(tournamentId, userId);
    if (assignment.tableId?.toString() !== tableId.toString()) {
      throw new Error('You are assigned to another tournament table');
    }
    if (!['active', 'registered', 'waiting'].includes(assignment.status)) {
      throw new Error(`Cannot join tournament with status ${assignment.status}`);
    }

    return {
      assignment,
      player: {
        userId,
        username,
        chips: Number(assignment.chips || 0),
        socketId,
      },
    };
  }

  async onTournamentHandCompleted(tableId, orchestrator) {
    const tableDocResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
    if (!tableDocResult.success || !tableDocResult.data?.isTournament) {
      return { isTournament: false };
    }

    const tableDoc = tableDocResult.data;
    const tournamentId = this.toId(tableDoc.tournamentId);
    let tournament = await this.getTournament(tournamentId);
    const gameState = await gameStateManager.getGame(tableId);
    const tableState = await tableManager.getTable(tableId);
    const snapshot = gameState?.players?.length ? gameState.players : tableState.players;

    tournament = await this.advanceBlindLevelIfNeeded(tournament);
    await this.syncTournamentPlayerStacks(tournamentId, tableDoc.tournamentTableId, snapshot);
    const eliminationResult = await this.eliminateBustedPlayers(tournamentId, snapshot);
    const activePlayers = await this.getActiveTournamentPlayers(tournamentId);

    if (activePlayers.length <= 1) {
      await this.completeTournament(tournament, activePlayers[0] || null, orchestrator?.io || null);
      return { isTournament: true, completed: true, continueTable: false };
    }

    const activeAtThisTable = snapshot.filter(player => Number(player.chips || 0) > 0 && !player.disconnected);
    if (activePlayers.length <= Number(tournament.maxPlayersPerTable || 9) && !tournament.finalTableFormed) {
      const finalTable = await this.createFinalTable(tournament, activePlayers, orchestrator?.io || null);
      return {
        isTournament: true,
        finalTableFormed: true,
        continueTable: finalTable.tableId === tableId && activeAtThisTable.length >= 2,
        tableClosed: finalTable.tableId !== tableId,
        eliminations: eliminationResult.eliminations,
      };
    }

    if (activeAtThisTable.length < Number(tournament.minPlayersPerTable || 2)) {
      const mergeResult = await this.mergeShortTable(tournament, tableDoc, activeAtThisTable, orchestrator?.io || null);
      return {
        isTournament: true,
        tableClosed: !!mergeResult?.merged,
        continueTable: false,
        waitingForCapacity: !mergeResult?.merged,
        mergeResult,
      };
    }

    const rebalanceResult = await this.rebalanceAfterCompletedTable(
      tournament,
      tableDoc,
      activeAtThisTable,
      orchestrator?.io || null
    );

    if (rebalanceResult.movedPlayers.length > 0) {
      const updatedTableState = await tableManager.getTable(tableId);
      const playersRemainingHere = updatedTableState.players.filter(player =>
        Number(player.chips || 0) > 0 && !player.disconnected
      );

      if (playersRemainingHere.length < Number(tournament.minPlayersPerTable || 2)) {
        return {
          isTournament: true,
          continueTable: false,
          tableClosed: true,
          eliminations: eliminationResult.eliminations,
          rebalanced: rebalanceResult,
        };
      }
    }

    return {
      isTournament: true,
      continueTable: true,
      eliminations: eliminationResult.eliminations,
      rebalanced: rebalanceResult,
    };
  }

  async advanceBlindLevelIfNeeded(tournament) {
    const levels = this.normalizeBlindLevels(tournament.generatedBlindLevels || []);
    const currentLevelNumber = Number(tournament.currentLevel?.levelNumber || 1);
    const currentLevel = levels.find(level => level.levelNumber === currentLevelNumber) || levels[0];
    const levelStartedAt = tournament.currentLevel?.startedAt || tournament.levelStartTime || tournament.startedAt;
    const durationMinutes = Number(currentLevel?.duration || tournament.levelDuration || 15);

    if (!levelStartedAt || durationMinutes <= 0) {
      return tournament;
    }

    const elapsedMs = Date.now() - new Date(levelStartedAt).getTime();
    if (elapsedMs < durationMinutes * 60 * 1000) {
      return tournament;
    }

    const nextLevel = levels.find(level => level.levelNumber === currentLevelNumber + 1);
    if (!nextLevel) {
      return tournament;
    }

    const updatedCurrentLevel = {
      levelNumber: nextLevel.levelNumber,
      smallBlind: nextLevel.smallBlind,
      bigBlind: nextLevel.bigBlind,
      ante: nextLevel.ante || 0,
      startedAt: new Date(),
    };

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      this.toId(tournament._id),
      {
        currentLevel: updatedCurrentLevel,
        levelStartTime: updatedCurrentLevel.startedAt,
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error || 'Failed to advance tournament blind level');
    }

    await this.syncActiveTableBlindConfigs(tournament._id, updatedCurrentLevel);

    return {
      ...tournament,
      currentLevel: updatedCurrentLevel,
      levelStartTime: updatedCurrentLevel.startedAt,
    };
  }

  async syncActiveTableBlindConfigs(tournamentId, currentLevel) {
    const tablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, {
      tournamentId: this.toId(tournamentId),
      isTournament: true,
    });

    if (!tablesResult.success) {
      return;
    }

    for (const table of tablesResult.data || []) {
      if (table.status === 'archived') continue;
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TABLES,
        table._id,
        {
          tournamentConfig: {
            ...(table.tournamentConfig || {}),
            currentLevel,
          },
        },
        mongoHelper.MODELS.TABLE
      );
    }
  }

  async syncTournamentPlayerStacks(tournamentId, tournamentTableId, players = []) {
    const tournament = await this.getTournament(tournamentId);
    const currentBigBlind = Math.max(1, Number(tournament.currentLevel?.bigBlind || 1));

    for (const player of players) {
      const userId = player.id || player.userId;
      const found = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
        tournament: tournamentId,
        user: userId,
      });
      const tournamentPlayer = found.success ? found.data?.[0] : null;
      if (!tournamentPlayer) continue;

      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
        tournamentPlayer._id,
        {
          chipsInPlay: Math.max(0, Number(player.chips || 0)),
          bigBlindsAvailable: Number(player.chips || 0) / currentBigBlind,
          tableId: tournamentTableId || tournamentPlayer.tableId,
        },
        mongoHelper.MODELS.TOURNAMENT_PLAYER
      );
    }
  }

  async eliminateBustedPlayers(tournamentId, players = []) {
    const tournament = await this.getTournament(tournamentId);
    let nextPosition = Number(tournament.nextEliminationPosition || (tournament.players || []).length);
    const eliminations = [];

    const busted = players
      .filter(player => Number(player.chips || 0) <= 0)
      .map(player => player.id || player.userId)
      .filter(Boolean);

    for (const userId of busted) {
      const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
        tournament: tournamentId,
        user: userId,
      });
      const tournamentPlayer = result.success ? result.data?.[0] : null;
      if (!tournamentPlayer || tournamentPlayer.status === 'eliminated') continue;

      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
        tournamentPlayer._id,
        {
          status: 'eliminated',
          chipsInPlay: 0,
          eliminatedAt: new Date(),
          eliminatedPosition: nextPosition,
        },
        mongoHelper.MODELS.TOURNAMENT_PLAYER
      );
      eliminations.push({ userId, position: nextPosition });
      nextPosition -= 1;
    }

    if (eliminations.length > 0) {
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENTS,
        tournamentId,
        { nextEliminationPosition: nextPosition },
        mongoHelper.MODELS.TOURNAMENT
      );
    }

    return { eliminations, nextPosition };
  }

  async getActiveTournamentPlayers(tournamentId) {
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
    });
    if (!result.success) throw new Error(result.error || 'Failed to load active tournament players');
    return (result.data || []).filter(player => player.status !== 'eliminated' && Number(player.chipsInPlay || 0) > 0);
  }

  async getTournamentTableCapacity(entry, maxPlayersPerTable) {
    const tableState = await tableManager.getTable(entry.tableId);
    const seatedCount = (tableState.players || []).filter(player =>
      Number(player.chips || 0) > 0 && !player.disconnected
    ).length;

    return {
      ...entry,
      seatedCount,
      availableSeats: Math.max(0, Number(maxPlayersPerTable || 9) - seatedCount),
    };
  }

  async mergeShortTable(tournament, tableDoc, activeAtShortTable, io = null) {
    const tournamentId = this.toId(tournament._id);
    const maxPlayersPerTable = Number(tournament.maxPlayersPerTable || 9);
    const activePlayersToMove = (activeAtShortTable || []).filter(player =>
      Number(player.chips || 0) > 0 && !player.disconnected
    );

    if (activePlayersToMove.length === 0) {
      return { merged: true, movedPlayers: [], targets: [] };
    }

    const candidateEntries = (tournament.underlyingTables || []).filter(entry =>
      entry.status === 'ACTIVE' &&
      this.toId(entry.tableId) !== this.toId(tableDoc._id) &&
      !entry.isFinalTable
    );

    const candidateTables = [];
    for (const entry of candidateEntries) {
      const capacity = await this.getTournamentTableCapacity(entry, maxPlayersPerTable);
      if (capacity.availableSeats > 0) {
        candidateTables.push(capacity);
      }
    }

    candidateTables.sort((a, b) => b.availableSeats - a.availableSeats || a.seatedCount - b.seatedCount);

    const totalAvailableSeats = candidateTables.reduce((sum, table) => sum + table.availableSeats, 0);
    if (totalAvailableSeats < activePlayersToMove.length) {
      if (io) {
        emitSuccess(io.to(tableDoc._id.toString()), 'tournamentTableWaitingForMerge', {
          tournamentId,
          tableId: tableDoc._id,
          reason: 'NO_TARGET_CAPACITY',
          waitingPlayers: activePlayersToMove.map(player => player.id || player.userId),
        }, 'Waiting for seats to open at another tournament table');
      }

      return {
        merged: false,
        reason: 'NO_TARGET_CAPACITY',
        movedPlayers: [],
        targets: candidateTables.map(table => ({
          tableId: table.tableId,
          availableSeats: table.availableSeats,
        })),
      };
    }

    const assignments = [];
    let targetIndex = 0;
    for (const player of activePlayersToMove) {
      while (targetIndex < candidateTables.length && candidateTables[targetIndex].availableSeats <= 0) {
        targetIndex += 1;
      }

      const target = candidateTables[targetIndex];
      if (!target) break;

      assignments.push({ player, target });
      target.availableSeats -= 1;
    }

    const movedPlayers = [];
    for (const { player, target } of assignments) {
      const userId = player.id || player.userId;
      const found = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
        tournament: tournamentId,
        user: userId,
      });
      const tournamentPlayer = found.success ? found.data?.[0] : null;
      if (!tournamentPlayer) continue;

      await tableManager.removePlayer(tableDoc._id, userId);
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
        tournamentPlayer._id,
        { tableId: target.tournamentTableId, seatPosition: 0 },
        mongoHelper.MODELS.TOURNAMENT_PLAYER
      );

      movedPlayers.push({
        userId,
        fromTableId: tableDoc._id,
        toTableId: target.tableId,
        toTournamentTableId: target.tournamentTableId,
      });

      if (io) {
        emitSuccess(io.to(`user_${userId}`), 'tournamentTableMoved', {
          tournamentId,
          tableId: target.tableId,
          fromTableId: tableDoc._id,
          reason: 'TABLE_MERGE',
        }, 'You have been moved to another tournament table');
      }
    }

    const underlyingTables = (tournament.underlyingTables || []).map(entry =>
      this.toId(entry.tableId) === this.toId(tableDoc._id) ? { ...entry, status: 'MERGED' } : entry
    );
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      { underlyingTables },
      mongoHelper.MODELS.TOURNAMENT
    );
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
      tableDoc.tournamentTableId,
      { status: 'MERGED', isActive: false },
      mongoHelper.MODELS.TOURNAMENT_TABLES
    );

    return {
      merged: true,
      movedPlayers,
      targets: [...new Set(movedPlayers.map(player => player.toTableId))],
    };
  }

  async rebalanceAfterCompletedTable(tournament, completedTableDoc, activeAtCompletedTable, io = null) {
    const tournamentId = this.toId(tournament._id);
    const maxPlayersPerTable = Number(tournament.maxPlayersPerTable || 9);
    const activeTables = (tournament.underlyingTables || []).filter(entry =>
      entry.status === 'ACTIVE' &&
      !entry.isFinalTable &&
      this.toId(entry.tableId) !== this.toId(completedTableDoc._id)
    );

    if (activeTables.length === 0 || activeAtCompletedTable.length <= 0) {
      return { movedPlayers: [] };
    }

    const tableCounts = [];
    for (const entry of activeTables) {
      const tableState = await tableManager.getTable(entry.tableId);
      const activeCount = (tableState.players || []).filter(player =>
        Number(player.chips || 0) > 0 && !player.disconnected
      ).length;
      tableCounts.push({ ...entry, activeCount });
    }

    tableCounts.sort((a, b) => a.activeCount - b.activeCount);
    const target = tableCounts[0];
    if (!target) {
      return { movedPlayers: [] };
    }

    const sourceCount = activeAtCompletedTable.length;
    const shouldMove = sourceCount - target.activeCount > 1 && target.activeCount < maxPlayersPerTable;
    if (!shouldMove) {
      return { movedPlayers: [] };
    }

    const moveCount = Math.min(
      Math.floor((sourceCount - target.activeCount) / 2),
      maxPlayersPerTable - target.activeCount
    );
    const candidates = [...activeAtCompletedTable]
      .sort((a, b) => Number(a.seatPosition || 0) - Number(b.seatPosition || 0))
      .slice(-moveCount);

    const movedPlayers = [];
    for (const player of candidates) {
      const userId = player.id || player.userId;
      const found = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
        tournament: tournamentId,
        user: userId,
      });
      const tournamentPlayer = found.success ? found.data?.[0] : null;
      if (!tournamentPlayer) continue;

      await tableManager.removePlayer(completedTableDoc._id, userId);
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
        tournamentPlayer._id,
        { tableId: target.tournamentTableId, seatPosition: 0 },
        mongoHelper.MODELS.TOURNAMENT_PLAYER
      );

      movedPlayers.push({
        userId,
        fromTableId: completedTableDoc._id,
        toTableId: target.tableId,
      });

      if (io) {
        emitSuccess(io.to(`user_${userId}`), 'tournamentTableMoved', {
          tournamentId,
          tableId: target.tableId,
          fromTableId: completedTableDoc._id,
          reason: 'TABLE_REBALANCE',
        }, 'You have been moved to balance tournament tables');
      }
    }

    return { movedPlayers };
  }

  async createFinalTable(tournament, activePlayers, io = null) {
    const tournamentId = this.toId(tournament._id);
    const firstLevel = tournament.currentLevel;
    const previousTables = tournament.underlyingTables || [];
    const tableRecord = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
      {
        tournamentId,
        tableNumber: 1,
        maxPlayers: Number(tournament.maxPlayersPerTable || 9),
        currentPlayers: activePlayers.map(player => player._id),
        players: activePlayers.map((player, seatIndex) => ({
          tournamentPlayerId: player._id,
          userId: player.user,
          seatPosition: seatIndex + 1,
          chips: Number(player.chipsInPlay || 0),
          status: 'ACTIVE',
        })),
        blindLevel: firstLevel,
        status: 'ACTIVE',
        isActive: true,
        isFinalTable: true,
      },
      mongoHelper.MODELS.TOURNAMENT_TABLES
    );
    if (!tableRecord.success) throw new Error(tableRecord.error || 'Failed to create final table record');

    const underlying = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TABLES,
      {
        maxPlayers: Number(tournament.maxPlayersPerTable || 9),
        currentPlayers: [],
        status: 'in-use',
        isTournament: true,
        tournamentId,
        tournamentTableId: tableRecord.data._id,
        tournamentTableNumber: 1,
        tournamentConfig: {
          currentLevel: firstLevel,
          turnTimer: Number(tournament.timerSeconds || 20),
          startingChips: Number(tournament.startingChips || 10000),
        },
      },
      mongoHelper.MODELS.TABLE
    );
    if (!underlying.success) throw new Error(underlying.error || 'Failed to create final game table');

    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
      tableRecord.data._id,
      { tableId: underlying.data._id },
      mongoHelper.MODELS.TOURNAMENT_TABLES
    );

    for (let index = 0; index < activePlayers.length; index += 1) {
      const player = activePlayers[index];
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
        player._id,
        { tableId: tableRecord.data._id, seatPosition: index + 1 },
        mongoHelper.MODELS.TOURNAMENT_PLAYER
      );

      if (io) {
        emitSuccess(io.to(`user_${this.toId(player.user)}`), 'finalTableFormed', {
          tournamentId,
          tableId: underlying.data._id,
        }, 'Final table formed');
      }
    }

    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        finalTableFormed: true,
        finalTableFormedAt: new Date(),
        activeTables: [tableRecord.data._id],
        underlyingTables: [{
          tableId: underlying.data._id,
          tournamentTableId: tableRecord.data._id,
          tableNumber: 1,
          status: 'ACTIVE',
          isFinalTable: true,
        }],
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    for (const previous of previousTables) {
      if (!previous.tournamentTableId) continue;
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_TABLES,
        previous.tournamentTableId,
        { status: 'MERGED', isActive: false },
        mongoHelper.MODELS.TOURNAMENT_TABLES
      );

      if (previous.tableId) {
        await tableManager.clearPlayers(previous.tableId, 'MERGED');
      }
    }

    return { tableId: underlying.data._id, tournamentTableId: tableRecord.data._id };
  }

  buildPayouts(tournament, standings) {
    const prizePool = Number(tournament.prizePool || 0);
    let paidTotal = 0;
    const payouts = (tournament.payoutStructure || [])
      .map(row => {
        const standing = standings.find(item => Number(item.position) === Number(row.position));
        if (!standing) return null;
        const prize = this.floorToCents(prizePool * (Number(row.percentage || 0) / 100));
        paidTotal = this.normalizeAmount(paidTotal + prize);
        return {
          position: Number(row.position),
          userId: standing.userId,
          prize,
          paidAt: new Date(),
        };
      })
      .filter(Boolean);

    return {
      payouts,
      roundingRemainder: this.normalizeAmount(prizePool - paidTotal),
    };
  }

  async completeTournament(tournament, winnerPlayer, io = null) {
    const tournamentId = this.toId(tournament._id);
    if (tournament.status === 'completed') return tournament;

    const playerResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
    });
    const allPlayers = playerResult.success ? playerResult.data || [] : [];

    const standings = allPlayers
      .map(player => ({
        userId: this.toId(player.user),
        position: player.status === 'eliminated'
          ? Number(player.eliminatedPosition || 999999)
          : 1,
        finalChips: Number(player.chipsInPlay || 0),
      }))
      .sort((a, b) => a.position - b.position);

    if (winnerPlayer) {
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
        winnerPlayer._id,
        { status: 'winner', eliminatedPosition: 1 },
        mongoHelper.MODELS.TOURNAMENT_PLAYER
      );
    }

    const { payouts, roundingRemainder } = this.buildPayouts(tournament, standings);
    const walletResults = payouts.length > 0
      ? await walletIntegrationService.distributePrizePool(
          payouts.map(payout => ({
            userId: payout.userId,
            amount: payout.prize,
            position: payout.position,
          })),
          tournamentId
        )
      : [];

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        status: 'completed',
        completedAt: new Date(),
        winners: payouts,
        roundingRemainder: this.normalizeAmount(Number(tournament.roundingRemainder || 0) + roundingRemainder),
        settlementSummary: {
          standings,
          payouts,
          walletResults,
          roundingRemainder,
        },
      },
      mongoHelper.MODELS.TOURNAMENT
    );
    if (!updateResult.success) throw new Error(updateResult.error || 'Failed to complete tournament');

    if (io) {
      emitSuccess(io.to(`tournament_${tournamentId}`), 'tournamentCompleted', {
        tournamentId,
        standings,
        payouts,
      }, 'Tournament completed');
    }

    return updateResult.data;
  }

  async commencePendingTournaments(io = null) {
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENTS, {
      status: 'registering',
    });
    if (!result.success) return [];

    const now = Date.now();
    const due = (result.data || []).filter(tournament => new Date(tournament.startTime).getTime() <= now);
    const started = [];

    for (const tournament of due) {
      try {
        started.push(await this.startTournament(tournament._id, io));
      } catch (error) {
        console.error(`[TOURNAMENT] Failed auto-start for ${tournament._id}:`, error.message);
      }
    }

    return started;
  }
}

module.exports = new TournamentGameService();
