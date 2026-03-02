const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const matchmakingService = require('../services/matchmaking.service');


// exports.getSubTierQueue = catchAsync(async (req, res, next) => {
//   const { subTierId } = req.params;

//   const subTier = await SubTier.findById(subTierId).populate('playersInQueue.playerId');

//   res.status(200).json({
//     status: 'success',
//     data: {
//       queue: subTier.playersInQueue,
//       queueLength: subTier.playersInQueue.length
//     }
//   });
// });

// exports.getTierTables = catchAsync(async (req, res, next) => {
//   const { tierId } = req.params;

//   const tables = await MatchmakingTable.find({ tierId })
//     .populate('currentPlayerIds')
//     .sort({ createdAt: -1 });

//   res.status(200).json({
//     status: 'success',
//     data: {
//       tables
//     }
//   });
// });

// REST API for matchmaking (for testing)
exports.initializeMatchmaking = catchAsync(async (req, res) => {
  const result = await matchmakingService.initializeMatchmaking();
  res.status(200).json({
    status: 'success',
    data: result
  });
});

exports.processMatchmaking = catchAsync(async (req, res) => {
  let {
    userId,
    userAddress,
    subTierId,
    chipsInPlay
  } = req.body;

  const result = await matchmakingService.processMatchmaking(userId, userAddress, subTierId, chipsInPlay);
  res.status(200).json({
    status: 'success',
    data: result
  });
});

exports.getMatchmakingStatus = catchAsync(async (req, res) => {
  const result = await matchmakingService.getMatchmakingStatus();
  res.status(200).json({
    status: 'success',
    data: result
  });
});

exports.cleanupTestData = catchAsync(async (req, res) => {
  const result = await matchmakingService.cleanupTestData();
  res.status(200).json({
    status: 'success',
    data: result
  });
});

exports.getTiersWithSubTiers = catchAsync(async (req, res) => {
  console.log(req.user)
  const userId = req.user?._id || req.query.userId;
  const result = await matchmakingService.getTiersWithSubTiers(userId);
  res.status(200).json({
    status: 'success',
    data: result
  });
});
