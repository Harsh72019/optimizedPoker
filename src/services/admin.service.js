const mongoHelper = require('../models/customdb');
const userService = require('./user.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');
const bcrypt = require('bcrypt');
const {abi: polygonTokenContractABI} = require('./MyToken.json');
const {ethers} = require('ethers');
const config = require('../config/config');

const loginAdmin = async (email, password) => {
  try {
    const adminResult = await mongoHelper.find(mongoHelper.COLLECTIONS.ADMINS, {email : email});
    console.log(adminResult , "adminResult")
    if (!adminResult.success || !adminResult.data.length) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Admin not found');
    }

    const admin = adminResult.data[0];
    console.log(password , "password" , "admin.password" , admin.password)
    const isPasswordMatch = await bcrypt.compare(password, admin.password);
    console.log(isPasswordMatch , "isPasswordMatch")
    if (!isPasswordMatch) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid password');
    }

    return admin;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const getAdminByEmail = async email => {
  try {
    const adminResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMINS, 'email', email);

    if (!adminResult.success || !adminResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Admin not found');
    }

    return adminResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const getAdminById = async id => {
  try {
    const adminResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.ADMINS, id);

    if (!adminResult.success || !adminResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Admin not found');
    }

    return adminResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const updateAdminById = async (adminId, updateBody) => {
  try {
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.ADMINS,
      adminId,
      updateBody,
      mongoHelper.MODELS.ADMIN
    );

    if (!updateResult.success) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Admin not found');
    }

    return updateResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const listOfUsers = async (keyword, isBlocked, options) => {
  try {
    let filter = {};

    if (keyword) {
      const keywordRegex = new RegExp(keyword, 'i');
      filter.$or = [{_id: keyword}, {username: keywordRegex}];
    }

    if (isBlocked !== undefined) {
      filter.isBlocked = isBlocked === 'true';
    }

    let sortedResults;

    if (options.sortBy && options.sortBy !== 'createdAt') {
      const sortDirection = options.sortOrder === 'desc' ? -1 : 1;

      const sortFields = [
        {
          field: options.sortBy,
          direction: sortDirection,
        },
      ];

      const sortResult = await mongoHelper.sort(mongoHelper.COLLECTIONS.USERS, sortFields, filter);

      if (!sortResult.success) {
        throw new Error('Failed to sort users');
      }

      const page = parseInt(options.page) || 1;
      const limit = parseInt(options.limit) || 10;
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;

      const totalResults = sortResult.totalResults || sortResult.data.length;
      const totalPages = Math.ceil(totalResults / limit);
      const paginatedData = sortResult.data.slice(startIndex, endIndex);

      sortedResults = {
        success: true,
        results: paginatedData,
        page: page,
        limit: limit,
        totalResults: totalResults,
        totalPages: totalPages,
      };
    } else {
      sortedResults = await mongoHelper.paginate(
        mongoHelper.COLLECTIONS.USERS,
        filter,
        options.page || 1,
        options.limit || 10
      );
    }

    if (!sortedResults.success) {
      throw new Error('Failed to fetch users');
    }

    const resultsWithBalance = await Promise.all(
      sortedResults.results.map(async user => {
        try {
          const balance = await userService.getBalance(user.walletAddress);
          return {
            ...user,
            walletBalance: balance,
            walletAddress: undefined,
          };
        } catch (error) {
          console.error(`Failed to fetch balance for user ${user._id}:`, error);
          return {
            ...user,
            walletBalance: '0',
            walletAddress: undefined,
          };
        }
      })
    );

    return {
      page: parseInt(sortedResults.page),
      limit: parseInt(sortedResults.limit),
      results: resultsWithBalance,
      totalPages: parseInt(sortedResults.totalPages) || 0,
      totalResults: parseInt(sortedResults.totalResults) || 0,
    };
  } catch (error) {
    throw new Error(`Failed to fetch users list: ${error.message}`);
  }
};

const viewUser = async userId => {
  try {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);

    if (!userResult.success || !userResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }

    const user = userResult.data;
    const balance = await userService.getBalance(user.walletAddress);

    return {
      ...user,
      walletBalance: balance,
      walletAddress: undefined,
    };
  } catch (error) {
    throw new Error(`Failed to fetch user details: ${error.message}`);
  }
};

const toggleUserBlock = async userId => {
  try {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);

    if (!userResult.success || !userResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }

    const user = userResult.data;
    const newBlockStatus = !user.isBlocked;

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      {isBlocked: newBlockStatus},
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error('Failed to update user block status');
    }

    return {
      userId: user._id,
      username: user.username,
      isBlocked: newBlockStatus,
      status: newBlockStatus ? 'blocked' : 'unblocked',
    };
  } catch (error) {
    throw new Error(`Failed to toggle user block status: ${error.message}`);
  }
};

const getCurrentTables = async (options = {}) => {
  try {
    const tablesResult = await mongoHelper.paginate(
      mongoHelper.COLLECTIONS.TABLES,
      {},
      options.page || 1,
      options.limit || 10
    );

    if (!tablesResult.success) {
      throw new Error('Failed to fetch tables');
    }

    const populatedTables = [];
    for (const table of tablesResult.results) {
      const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId);
      const gameStateResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.GAME_STATES, table.gameState);
      const currentPlayersCount = table.currentPlayers ? table.currentPlayers.length : 0;

      populatedTables.push({
        _id: table._id,
        maxPlayers: table.maxPlayers,
        currentPlayers: currentPlayersCount,
        tableTypeId: tableTypeResult.success ? tableTypeResult.data : null,
        gameState: gameStateResult.success ? gameStateResult.data : null,
        createdAt: table.createdAt,
        updatedAt: table.updatedAt,
        lastActivity: table.updatedAt,
        dealerPosition: table.dealerPosition,
        currentTurnPosition: table.currentTurnPosition,
        gameRoundsCompleted: table.gameRoundsCompleted,
      });
    }

    return {
      page: parseInt(tablesResult.page),
      limit: parseInt(tablesResult.limit),
      results: populatedTables,
      totalPages: parseInt(tablesResult.totalPages) || 0,
      totalResults: parseInt(tablesResult.totalResults) || 0,
    };
  } catch (error) {
    throw new Error(`Failed to fetch current tables: ${error.message}`);
  }
};

const getArchivedTables = async (options = {}) => {
  try {
    const filter = {
      status: 'archived',
    };

    const archivedTablesResult = await mongoHelper.paginate(
      mongoHelper.COLLECTIONS.ARCHIVED_TABLES,
      filter,
      options.page || 1,
      options.limit || 10
    );

    if (!archivedTablesResult.success) {
      throw new Error('Failed to fetch archived tables');
    }

    const populatedTables = [];
    for (const table of archivedTablesResult.results) {
      const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId);

      populatedTables.push({
        _id: table._id,
        tableTypeId: tableTypeResult.success ? tableTypeResult.data : null,
        participantCount: table.participants ? table.participants.length : 0,
        totalRounds: table.totalRounds,
        startedAt: table.startedAt,
        endedAt: table.endedAt,
        archivedReason: table.archivedReason,
        status: table.status,
      });
    }

    return {
      page: parseInt(archivedTablesResult.page),
      limit: parseInt(archivedTablesResult.limit),
      results: populatedTables,
      totalPages: parseInt(archivedTablesResult.totalPages) || 0,
      totalResults: parseInt(archivedTablesResult.totalResults) || 0,
    };
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to fetch archived tables: ${error.message}`);
  }
};

const getArchivedTableById = async id => {
  try {
    const archivedTableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.ARCHIVED_TABLES, id);

    if (!archivedTableResult.success || !archivedTableResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Archived table not found');
    }

    const archivedTable = archivedTableResult.data;

    const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, archivedTable.tableTypeId);

    const populatedParticipants = [];
    if (archivedTable.participants) {
      for (const participant of archivedTable.participants) {
        const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, participant.userId);
        populatedParticipants.push({
          ...participant,
          userId: userResult.success ? userResult.data : null,
        });
      }
    }

    return {
      ...archivedTable,
      tableTypeId: tableTypeResult.success ? tableTypeResult.data : null,
      participants: populatedParticipants,
    };
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to fetch archived table');
  }
};

const changePassword = async (adminId, oldPassword, newPassword) => {
  try {
    const adminResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.ADMINS, adminId);

    if (!adminResult.success || !adminResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Admin not found');
    }

    const admin = adminResult.data;

    const isPasswordMatch = await bcrypt.compare(oldPassword, admin.password);
    if (!isPasswordMatch) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.ADMINS,
      adminId,
      {password: hashedPassword},
      mongoHelper.MODELS.ADMIN
    );

    if (!updateResult.success) {
      throw new Error('Failed to update password');
    }

    return updateResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const getTableTypes = async (status, options) => {
  try {
    console.log('🚀 ~ getTableTypes ~ options:', options);
    const filter = {};
    if (status) {
      console.log('🚀 ~ getTableTypes ~ status:', status);
      filter.status = status;
    }

    const tableTypesResult = await mongoHelper.paginate(
      mongoHelper.COLLECTIONS.TABLE_TYPES,
      filter,
      options.page || 1,
      options.limit || 10
    );

    if (!tableTypesResult.success) {
      throw new Error('Failed to fetch table types');
    }

    return {
      page: parseInt(tableTypesResult.page),
      limit: parseInt(tableTypesResult.limit),
      results: tableTypesResult.results,
      totalPages: parseInt(tableTypesResult.totalPages) || 0,
      totalResults: parseInt(tableTypesResult.totalResults) || 0,
    };
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to fetch table types');
  }
};

const getTableTypeById = async id => {
  try {
    const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, id);

    if (!tableTypeResult.success || !tableTypeResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Table type not found');
    }

    return tableTypeResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const updateTableType = async (id, updateBody) => {
  try {
    const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, id);

    if (!tableTypeResult.success || !tableTypeResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Table type not found');
    }

    const overlappingTableResult = await mongoHelper.filter(mongoHelper.COLLECTIONS.TABLE_TYPES, {
      $and: [
        {_id: {$ne: id}},
        {
          $or: [
            {
              minBuyIn: {
                $lte: updateBody.maxBuyIn,
                $gte: updateBody.minBuyIn,
              },
            },
            {
              maxBuyIn: {
                $lte: updateBody.maxBuyIn,
                $gte: updateBody.minBuyIn,
              },
            },
          ],
        },
      ],
    });

    if (overlappingTableResult.success && overlappingTableResult.data.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Buy-in range overlaps with existing table type');
    }

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TABLE_TYPES,
      id,
      updateBody,
      mongoHelper.MODELS.TABLE_TYPE
    );

    if (!updateResult.success) {
      throw new Error('Failed to update table type');
    }

    return updateResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const deleteTableType = async id => {
  try {
    const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, id);

    if (!tableTypeResult.success || !tableTypeResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Table type not found');
    }

    const existingTablesResult = await mongoHelper.count(mongoHelper.COLLECTIONS.TABLES, {tableTypeId: id});

    if (existingTablesResult.success && existingTablesResult.data > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete table type with active tables');
    }

    const deleteResult = await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TABLE_TYPES, id);

    if (!deleteResult.success) {
      throw new Error('Failed to delete table type');
    }

    return true;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const toggleTableTypeStatus = async id => {
  try {
    const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, id);

    if (!tableTypeResult.success || !tableTypeResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Table type not found');
    }

    const tableType = tableTypeResult.data;
    const newStatus = tableType.status === 'active' ? 'inactive' : 'active';

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TABLE_TYPES,
      id,
      {status: newStatus},
      mongoHelper.MODELS.TABLE_TYPE
    );

    if (!updateResult.success) {
      throw new Error('Failed to update table type status');
    }

    return updateResult.data;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const addTableType = async tableTypeData => {
  try {
    const overlappingTableResult = await mongoHelper.filter(mongoHelper.COLLECTIONS.TABLE_TYPES, {
      $or: [
        {
          minBuyIn: {
            $lte: tableTypeData.maxBuyIn,
            $gte: tableTypeData.minBuyIn,
          },
        },
        {
          maxBuyIn: {
            $lte: tableTypeData.maxBuyIn,
            $gte: tableTypeData.minBuyIn,
          },
        },
      ],
    });

    if (overlappingTableResult.success && overlappingTableResult.data.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Buy-in range overlaps with existing table type');
    }

    const createResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TABLE_TYPES,
      {...tableTypeData , status : "active"},
      mongoHelper.MODELS.TABLE_TYPE
    );

    if (!createResult.success) {
      throw new Error('Failed to create table type');
    }

    return createResult.data;
  } catch (error) {
    throw new ApiError(error.statusCode || httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const getActiveTableDetail = async tableId => {
  try {
    const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);

    if (!tableResult.success || !tableResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Table not found');
    }

    const table = tableResult.data;

    const populatedPlayers = [];
    if (table.currentPlayers) {
      for (const playerId of table.currentPlayers) {
        const playerResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.PLAYERS, playerId, [
          {
            path: 'user',
            collection: mongoHelper.COLLECTIONS.USERS,
            select: 'username walletAddress profilePic',
          },
        ]);

        if (playerResult.success) {
          populatedPlayers.push(playerResult.data);
        }
      }
    }

    let gameState = null;
    if (table.gameState) {
      const gameStateResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.GAME_STATES, table.gameState);
      if (gameStateResult.success) {
        gameState = gameStateResult.data;
      }
    }

    let tableType = null;
    if (table.tableTypeId) {
      const tableTypeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId);
      if (tableTypeResult.success) {
        tableType = tableTypeResult.data;
      }
    }

    return {
      tableId: table._id,
      tableName: tableType?.tableName || 'Unknown',
      playerCount: populatedPlayers.length,
      maxPlayers: table.maxPlayers,
      players: populatedPlayers.map(player => ({
        id: player._id,
        username: player.user?.username || 'Unknown',
        walletAddress: player.user?.walletAddress || '',
        profilePic: player.user?.profilePic || '',
        chipsInPlay: player.chipsInPlay,
        status: player.status,
        seatPosition: player.seatPosition,
      })),
      gameState: {
        status: gameState?.status || 'waitingForPlayers',
        currentPot: gameState?.pot || 0,
        currentBet: gameState?.currentBet || 0,
        boardCards: gameState?.boardCards || [],
        currentRound: gameState?.currentRound || 0,
        lastActions: gameState?.actionHistory?.slice(-5) || [],
      },
      configuration: {
        minBuyIn: tableType?.minBuyIn || 0,
        maxBuyIn: tableType?.maxBuyIn || 0,
        smallBlind: tableType?.smallBlind || 0,
        bigBlind: tableType?.bigBlind || 0,
      },
      positions: {
        dealer: table.dealerPosition,
        smallBlind: table.smallBlindPosition,
        bigBlind: table.bigBlindPosition,
        currentTurn: table.currentTurnPosition,
      },
      totalRounds: table.gameRoundsCompleted,
      lastActivity: table.updatedAt,
    };
  } catch (error) {
    throw new ApiError(error.statusCode || httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

module.exports = {
  loginAdmin,
  getAdminByEmail,
  updateAdminById,
  listOfUsers,
  viewUser,
  toggleUserBlock,
  getCurrentTables,
  getArchivedTables,
  getArchivedTableById,
  changePassword,
  toggleTableTypeStatus,
  deleteTableType,
  getTableTypeById,
  getTableTypes,
  updateTableType,
  addTableType,
  getActiveTableDetail,
  getAdminById,
};
