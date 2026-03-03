const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const {userService, tournamentService} = require('../services');
const blockchainService = require('../services/blockchain.service');
// const tableRegistry = require('../services/redis.service');
const {Table} = require('../models');
const tableService = require('../services/table.service');

const updateUser = catchAsync(async (req, res) => {
  const updatedUser = await userService.updateUserById(req.user._id, req.body, req.file);
  res.status(200).send({data: updatedUser, message: 'Your details are updated'});
});

const updatePreferences = catchAsync(async (req, res) => {
  const updatedUser = await userService.updatePreferencesById(req.user._id, req.body);
  res.status(200).send({data: updatedUser, message: 'Your preferences are updated'});
});

const softDeleteUser = catchAsync(async (req, res) => {
  const {userId} = req.params;
  if (req.user.__t !== 'Admin' && userId !== req.user._id.toString()) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Sorry, you are not authorized to do this');
  }
  await userService.markUserAsDeletedById(req.params.userId);
  res.status(200).send({
    message: 'User has been removed successfully.',
  });
});

const deleteUser = catchAsync(async (req, res) => {
  await userService.deleteUserById(req.params.userId);
  res.status(200).send({message: 'The user deletion process has been completed successfully.'});
});

const deleteAllData = catchAsync(async (req, res) => {
  console.log('dsasdasdasdasd');
  await tableService.deleteAllData();
  res.status(200).send({message: 'The user deletion process has been completed successfully.'});
});

const getBalance = async (req, res) => {
  try {
    const walletBalance = await blockchainService.getBalance(req.user.walletAddress);
    res.status(200).send({
      message: 'The user wallet balance fetched successfully.',
      walletBalance,
      status: true,
    });
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const updateUserDetails = async (req, res) => {
  try {
    const details = await userService.updateUserDetails(req.body.username, req.user._id);
    res.status(200).send({
      message: 'The user details have been saved successfully.',
      details,
      status: true,
    });
  } catch (error) {
    console.error('Error fetching updating details:', error);
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const getTables = async (req, res) => {
  try {
    const tables = await userService.getTables();
    res.status(200).send({
      data: tables,
      status: true,
      message: 'Tables have been fetched successfully',
    });
  } catch (error) {
    console.error('Error fetching tables:', error);
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const userDetails = async (req, res) => {
  try {
    const tables = await userService.getUserById(req.user._id);
    res.status(200).send({
      data: tables,
      status: true,
    });
  } catch (error) {
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const getUserProfile = async (req, res) => {
  try {
    const profile = await userService.getUserProfile(req.user._id);
    res.status(200).send({
      data: profile,
      status: true,
      message: 'User profile fetched successfully'
    });
  } catch (error) {
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const listTournaments = catchAsync(async (req, res) => {
  const tournaments = await tournamentService.listAvailableTournaments(req.query);
  res.status(httpStatus.OK).json({
    status: true,
    message: 'Tournaments fetched successfully',
    data: tournaments,
  });
});

const registerForTournament = catchAsync(async (req, res) => {
  const registration = await tournamentService.registerPlayerForTournament(
    req.params.id,
    req.user._id,
    req.body.transactionId,
    req.body.email,
    req.body.name
  );

  res.status(httpStatus.OK).json({
    status: true,
    message:
      registration.status === 'registered' ? 'Successfully registered for tournament' : 'Added to tournament waitlist',
    data: registration,
  });
});

const getMyRegistrations = catchAsync(async (req, res) => {
  const registrations = await tournamentService.getPlayerRegistrations(req.user._id);
  res.status(httpStatus.OK).json({
    status: true,
    message: 'Registrations fetched successfully',
    data: registrations,
  });
});

const unregisterFromTournament = catchAsync(async (req, res) => {
  const result = await tournamentService.unregisterPlayerFromTournament(req.params.id, req.user._id);
  res.status(httpStatus.OK).json({
    status: true,
    message: 'Successfully unregistered from tournament',
    data: result,
  });
});

const checkTableExistence = async (req, res) => {
  try {
    const { playerCount, tableTypeId, chipsInPlay, autoRenew, maxBuy, selectedTableId, subTierId } = req.body;
    const userAddress = req.user.walletAddress;
    console.log(`🎮 [checkTableExistence] User ${req.user._id} requesting table`);
    
    // MODE DETECTION
    const isManualSelection = !!selectedTableId;
    const isMatchmaking = !!subTierId;
    
    // MODE 3: Matchmaking (NEW)
    if (isMatchmaking) {
      console.log(`🎯 [MATCHMAKING] User ${req.user._id} requesting matchmaking for subTier: ${subTierId}`);
      const matchmakingService = require('../services/matchmaking.service');
      
      const matchResult = await matchmakingService.processMatchmaking(
        req.user._id,
        userAddress,
        subTierId,
        chipsInPlay
      );
      
      return res.status(200).send({
        message: matchResult.message,
        data: matchResult.data,
        status: true,
      });
    }
    
    const tableType = await userService.getTableTypeById(tableTypeId);

    let userBalance = await blockchainService.getBalance(userAddress);
    userBalance = Math.floor(userBalance);

    if (userBalance < tableType.minBuyIn) {
      return res.status(200).send({
        message: `Cannot join table: Your balance must be at least ${tableType.minBuyIn}.`,
        status: false,
      });
    }

    const finalChipsInPlay =
      chipsInPlay < tableType.minBuyIn
        ? tableType.minBuyIn
        : chipsInPlay > tableType.maxBuyIn
        ? tableType.maxBuyIn
        : chipsInPlay;

    if (userBalance < finalChipsInPlay) {
      return res.status(200).send({
        message: `Insufficient balance. You need ${finalChipsInPlay} but have ${userBalance}.`,
        status: false,
        redirectToDeposit: true,
      });
    }

    let result;
    
    if (isManualSelection) {
      // MODE 2: User selected specific table
      console.log(`🎯 User selecting specific table: ${selectedTableId}`);
      
      const selectedTable = await tableService.getTableById(selectedTableId);
      
      if (!selectedTable) {
        return res.status(200).send({
          message: `Table ${selectedTableId} not found.`,
          status: false,
        });
      }
      
      if (selectedTable.currentPlayers.length >= selectedTable.maxPlayers) {
        return res.status(200).send({
          message: `Table ${selectedTableId} is full.`,
          status: false,
        });
      }
      
      const isAlreadyJoined = selectedTable.currentPlayers.some(player => 
        player.userId && player.userId.toString() === req.user._id.toString()
      );
      
      if (isAlreadyJoined) {
        return res.status(200).send({
          message: `You are already at this table.`,
          status: false,
        });
      }
      
      const blockchainResult = await blockchainService.prepareTableForJoin(
        selectedTable,
        finalChipsInPlay,
        userAddress
      );
      
      result = {
        tableData: blockchainResult.table,
        wasCreated: false,
        message: 'Table prepared for join',
      };
      
    } else {
      // MODE 1: Auto-find/create table (existing behavior)
      result = await blockchainService.findTableOrCreateThroughBlockchain(
        playerCount,
        tableTypeId,
        finalChipsInPlay,
        userAddress,
        req.user._id
      );
    }
    
    console.log('✅ [checkTableExistence] Table processed:', result.tableData._id);

    res.status(200).send({
      message: result.message,
      data: {
        blockChainTableId: result.tableData.tableBlockchainId,
        tableId: result.tableData._id,
        chipsInPlay: finalChipsInPlay,
        tableCreated: result.wasCreated,
        autoRenew,
        maxBuy,
      },
      status: true,
    });
  } catch (error) {
    console.error('Error in joinTable:', error);
    
    // Handle ApiError with proper status code
    if (error.statusCode) {
      return res.status(error.statusCode).send({
        message: error.message,
        status: false,
      });
    }
    
    res.status(500).send({
      message: error.message,
      status: false,
    });
  }
};

const processDistribution = async (req, res) => {
  try {
    const updatedTable = await blockchainService.processDistribution(
      req.body.tableId,
      req.body.address,
      req.body.amount
    );
    res.status(200).send({
      message: 'The details have been saved successfully successfully.',
      status: true,
      data: updatedTable,
    });
  } catch (error) {
    console.error('Error fetching updating details:', error);
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const setInitialTier = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user._id;
    
    const reputationService = require('../services/reputation.service');
    const result = await reputationService.setInitialTierByDeposit(userId, amount);
    
    res.status(200).send({
      message: result.isFirstDeposit ? 'Initial tier set successfully' : 'Tier already set',
      status: true,
      data: result
    });
  } catch (error) {
    console.error('Error setting initial tier:', error);
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

const addReferral = async (req, res) => {
  try {
    const { referralCode } = req.body;
    const userId = req.user._id;
    
    const recruitEarningsService = require('../services/recruitEarnings.service');
    const result = await recruitEarningsService.addRecruit(userId, referralCode);
    
    res.status(result.success ? 200 : 400).send({
      message: result.message,
      status: result.success,
      data: result.recruiter ? { recruiter: result.recruiter } : null
    });
  } catch (error) {
    console.error('Error adding referral:', error);
    res.status(500).send({
      error: error.message,
      status: false,
    });
  }
};

module.exports = {
  deleteUser,
  updateUser,
  softDeleteUser,
  updatePreferences,
  getBalance,
  getTables,
  userDetails,
  getUserProfile,
  updateUserDetails,
  listTournaments,
  registerForTournament,
  getMyRegistrations,
  unregisterFromTournament,
  checkTableExistence,
  processDistribution,
  deleteAllData,
  setInitialTier,
  addReferral,
};
