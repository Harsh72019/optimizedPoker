const httpStatus = require("http-status");
const crypto = require("crypto");

const catchAsync = require("../utils/catchAsync");
const mongoHelper = require('../models/customdb');

const gameEngineIntegrationService = require("../services/game-engine-integration.service");
const walletIntegrationService = require("../services/wallet-integration.service");


/* ------------------------------------------------ */
/* CREATE PRIVATE TABLE */
/* ------------------------------------------------ */

const createPrivateTable = catchAsync(async (req, res) => {

  const hostId = req.user.id;

  const {
    gameType,
    name,
    description,
    buyIn,
    declaredCapacity,
    participationThreshold,
    tier,
    hostUplift = 0,
    hostRewardPercent = 0,
    estimatedHours,
    timerSeconds,
    scheduledStartTime,
    password,
    tags = []
  } = req.body;

  const tableId = `pvt_${crypto.randomUUID()}`;

  const financialSetup = await gameEngineIntegrationService.onPrivateTableCreated({
    tableId,
    hostId,
    gameType,
    buyIn,
    maxPlayers: declaredCapacity,
    participationThreshold,
    tier,
    hostUplift,
    hostRewardPercent,
    estimatedHours,
    timerSeconds
  });

  const privateTableData = {
    _id: tableId,
    hostId,
    gameType,
    name,
    description,
    buyIn,
    declaredCapacity,
    participationThreshold,
    tier,

    tierRake: financialSetup.tierRake,
    hostUplift,
    effectiveRake: financialSetup.effectiveRake,
    hostRewardPercent,

    estimatedHours,
    timerSeconds,

    setupFeeAmount: financialSetup.setupFee.chargedAmount,
    setupFeePaid: true,
    setupFeeTransactionId: financialSetup.setupFee.transactionId,

    scheduledStartTime: scheduledStartTime
      ? new Date(scheduledStartTime)
      : null,

    password,
    tags,

    status: "WAITING_FOR_PLAYERS",
    registeredPlayers: [],
    waitlist: []
  };

  const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.PRIVATE_TABLES, privateTableData);
  
  if (!createResult.success) {
    throw new Error(`Failed to create private table: ${createResult.error}`);
  }

  res.status(httpStatus.CREATED).json({
    success: true,
    data: createResult.data
  });
});


/* ------------------------------------------------ */
/* GET TABLE */
/* ------------------------------------------------ */

const getPrivateTable = catchAsync(async (req, res) => {

  const { tableId } = req.params;

  const table = await PrivateTable
    .findById(tableId)
    .populate("hostId", "username email")
    .populate("registeredPlayers.userId", "username")
    .populate("winners.userId", "username");

  if (!table) {
    return res.status(httpStatus.NOT_FOUND).json({
      success: false,
      message: "Private table not found"
    });
  }

  res.json({
    success: true,
    data: table
  });
});


/* ------------------------------------------------ */
/* JOIN TABLE */
/* ------------------------------------------------ */

const joinPrivateTable = catchAsync(async (req, res) => {

  const { tableId } = req.params;
  const userId = req.user.id;
  const { password } = req.body;

  const table = await PrivateTable.findById(tableId);

  if (!table) {
    return res.status(httpStatus.NOT_FOUND).json({
      success: false,
      message: "Private table not found"
    });
  }

  if (table.password && table.password !== password) {
    return res.status(httpStatus.UNAUTHORIZED).json({
      success: false,
      message: "Invalid password"
    });
  }

  if (table.status !== "WAITING_FOR_PLAYERS") {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Table not accepting players"
    });
  }

  if (table.isFull) {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Table is full"
    });
  }

  const alreadyJoined = table.registeredPlayers.find(
    p => p.userId.toString() === userId
  );

  if (alreadyJoined) {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Already joined"
    });
  }

  const buyInResult = await walletIntegrationService.chargeBuyIn(
    userId,
    table.buyIn,
    tableId
  );

  await table.addPlayer(userId, buyInResult.transactionId);

  await table.reload?.();

  if (table.canStart()) {

    await table.startGame();

    await gameEngineIntegrationService.startPrivateTable({
      tableId,
      players: table.registeredPlayers
    });

  }

  res.json({
    success: true,
    data: {
      table,
      buyInCharged: table.buyIn,
      transactionId: buyInResult.transactionId,
      gameStarted: table.status === "ACTIVE"
    }
  });

});


/* ------------------------------------------------ */
/* LEAVE TABLE */
/* ------------------------------------------------ */

const leavePrivateTable = catchAsync(async (req, res) => {

  const { tableId } = req.params;
  const userId = req.user.id;

  const table = await PrivateTable.findById(tableId);

  if (!table) {
    return res.status(httpStatus.NOT_FOUND).json({
      success: false,
      message: "Private table not found"
    });
  }

  if (table.status !== "WAITING_FOR_PLAYERS") {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Cannot leave after game start"
    });
  }

  await table.removePlayer(userId);

  const refundResult = await walletIntegrationService.refundBuyIns(
    [userId],
    table.buyIn,
    tableId
  );

  res.json({
    success: true,
    data: {
      table,
      refund: refundResult[0]
    }
  });

});


/* ------------------------------------------------ */
/* HOST TABLES */
/* ------------------------------------------------ */

const getHostTables = catchAsync(async (req, res) => {

  const hostId = req.user.id;

  const {
    status,
    gameType,
    page = 1,
    limit = 10
  } = req.query;

  const filter = { hostId };

  if (status) filter.status = status;
  if (gameType) filter.gameType = gameType;

  const tables = await PrivateTable.paginate(filter, {
    page: Number(page),
    limit: Number(limit),
    sort: { createdAt: -1 },
    populate: [
      { path: "registeredPlayers.userId", select: "username" },
      { path: "winners.userId", select: "username" }
    ]
  });

  res.json({
    success: true,
    data: tables
  });

});


/* ------------------------------------------------ */
/* AVAILABLE TABLES */
/* ------------------------------------------------ */

const getAvailableTables = catchAsync(async (req, res) => {

  const {
    gameType,
    minBuyIn,
    maxBuyIn,
    page = 1,
    limit = 20
  } = req.query;

  const filter = {
    status: "WAITING_FOR_PLAYERS",
    password: { $exists: false }
  };

  if (gameType) filter.gameType = gameType;

  if (minBuyIn || maxBuyIn) {

    filter.buyIn = {};

    if (minBuyIn) filter.buyIn.$gte = Number(minBuyIn);
    if (maxBuyIn) filter.buyIn.$lte = Number(maxBuyIn);

  }

  const tables = await PrivateTable.paginate(filter, {
    page: Number(page),
    limit: Number(limit),
    sort: { createdAt: -1 },
    populate: [
      { path: "hostId", select: "username" }
    ]
  });

  res.json({
    success: true,
    data: tables
  });

});


/* ------------------------------------------------ */
/* COMPLETE GAME */
/* ------------------------------------------------ */

const completeGame = catchAsync(async (req, res) => {

  const { tableId } = req.params;
  const { winners } = req.body;

  const table = await PrivateTable.findById(tableId);

  if (!table) {
    return res.status(httpStatus.NOT_FOUND).json({
      success: false,
      message: "Private table not found"
    });
  }

  if (table.status !== "ACTIVE") {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Game not active"
    });
  }

  await table.completeGame(winners);

  const settlement =
    await gameEngineIntegrationService.onTournamentCompleted({

      gameId: tableId,
      gameType: table.gameType,
      hostId: table.hostId,
      buyIn: table.buyIn,
      declaredCapacity: table.declaredCapacity,
      actualParticipants: table.currentPlayerCount,
      participationThreshold: table.participationThreshold,
      tierRake: table.tierRake,
      hostUplift: table.hostUplift,
      hostRewardPercent: table.hostRewardPercent,
      setupFeeAmount: table.setupFeeAmount,
      affiliateId: table.affiliateId,
      winners

    });

  table.gameFinancialsId = settlement.gameFinancials._id;
  table.settlementCompleted = true;
  table.settlementCompletedAt = new Date();

  await table.save();

  res.json({
    success: true,
    data: {
      table,
      settlement: settlement.settlement
    }
  });

});


/* ------------------------------------------------ */
/* CANCEL TABLE */
/* ------------------------------------------------ */

const cancelTable = catchAsync(async (req, res) => {

  const { tableId } = req.params;
  const { reason } = req.body;
  const userId = req.user.id;

  const table = await PrivateTable.findById(tableId);

  if (!table) {
    return res.status(httpStatus.NOT_FOUND).json({
      success: false,
      message: "Private table not found"
    });
  }

  if (table.hostId.toString() !== userId) {
    return res.status(httpStatus.FORBIDDEN).json({
      success: false,
      message: "Only host can cancel"
    });
  }

  if (table.status === "COMPLETED") {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Cannot cancel completed game"
    });
  }

  await table.cancelGame(reason);

  const playerIds = table.registeredPlayers.map(p => p.userId);

  const refundResults = await walletIntegrationService.refundBuyIns(
    playerIds,
    table.buyIn,
    tableId
  );

  res.json({
    success: true,
    data: {
      table,
      totalRefunded: refundResults.length * table.buyIn
    }
  });

});


module.exports = {
  createPrivateTable,
  getPrivateTable,
  joinPrivateTable,
  leavePrivateTable,
  getHostTables,
  getAvailableTables,
  completeGame,
  cancelTable
};