const httpStatus = require("http-status");
const crypto = require("crypto");

const catchAsync = require("../utils/catchAsync");
const mongoHelper = require('../models/customdb');
const privateTableService = require('../services/private-table.service');
const PrivateTableValidator = require('../utils/private-table-validator');

/* ------------------------------------------------ */
/* CREATE PRIVATE TABLE */
/* ------------------------------------------------ */

const createPrivateTable = catchAsync(async (req, res) => {
  // Debug logging
  console.log('🚀 ~ createPrivateTable ~ req.user:', req.user);
  console.log('🚀 ~ createPrivateTable ~ req.body:', req.body);
  
  // Handle missing authentication
  if (!req.user || !req.user._id) {
    return res.status(httpStatus.UNAUTHORIZED).json({
      success: false,
      message: 'Authentication required. Please provide a valid token.'
    });
  }
  
  const hostId = req.user._id;
  const tableConfig = req.body;

  // Validate table configuration using the same validator as socket handler
  const validation = PrivateTableValidator.validate(tableConfig);
  if (!validation.valid) {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: 'Invalid table configuration',
      errors: validation.errors
    });
  }

  try {
    // Use the same service as socket handler
    const result = await privateTableService.createPrivateTable(hostId, tableConfig);

    res.status(httpStatus.CREATED).json({
      success: true,
      data: {
        privateTable: result.privateTable,
        setupFee: result.setupFee.chargedAmount,
        financialPreview: result.financialPreview
      },
      message: 'Private table created successfully'
    });
  } catch (error) {
    console.error('🚀 ~ createPrivateTable ~ error:', error);
    res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: error.message
    });
  }
});


/* ------------------------------------------------ */
/* GET TABLE */
/* ------------------------------------------------ */

const getPrivateTable = catchAsync(async (req, res) => {
  const { tableId } = req.params;
  const currentUserId = req.user?._id?.toString();

  try {
    console.log('🔍 [getPrivateTable] TableId:', tableId);
    
    // Get basic table data first
    const table = await privateTableService.getPrivateTable(tableId);

    console.log('🔍 [getPrivateTable] Result:', table ? 'Found' : 'Not found');

    if (!table) {
      return res.status(httpStatus.NOT_FOUND).json({
        success: false,
        message: "Private table not found"
      });
    }

    // Add ownership flag
    table.isTableCreatedByYou = currentUserId && table.hostId?.toString() === currentUserId;
    
    // Add additional permission flags
    table.canStart = table.isTableCreatedByYou && table.status === 'READY_TO_START';
    table.canCancel = table.isTableCreatedByYou && !['COMPLETED', 'CANCELLED'].includes(table.status);
    table.canJoin = !table.isTableCreatedByYou && table.status === 'WAITING_FOR_PLAYERS';

    // Manually populate host information
    if (table.hostId) {
      const hostResult = await mongoHelper.findById(
        mongoHelper.COLLECTIONS.USERS,
        table.hostId
      );
      
      if (hostResult.success && hostResult.data) {
        table.host = {
          username: hostResult.data.username,
          email: hostResult.data.email
        };
      }
    }

    // Manually populate registered players
    if (table.registeredPlayers && Array.isArray(table.registeredPlayers)) {
      const populatedPlayers = [];
      for (const player of table.registeredPlayers) {
        if (player.userId) {
          const userResult = await mongoHelper.findById(
            mongoHelper.COLLECTIONS.USERS,
            player.userId
          );
          
          if (userResult.success && userResult.data) {
            populatedPlayers.push({
              ...player,
              user: {
                username: userResult.data.username
              }
            });
          } else {
            populatedPlayers.push(player);
          }
        } else {
          populatedPlayers.push(player);
        }
      }
      table.registeredPlayers = populatedPlayers;
    }

    res.json({
      success: true,
      data: table
    });
  } catch (error) {
    console.error('🔍 [getPrivateTable] Error:', error);
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: error.message
    });
  }
});


/* ------------------------------------------------ */
/* JOIN TABLE */
/* ------------------------------------------------ */

const joinPrivateTable = catchAsync(async (req, res) => {
  const { tableId } = req.params;
  const userId = req.user._id;
  const { password } = req.body;

  try {
    // Check password first if required
    const privateTable = await privateTableService.getPrivateTable(tableId);
    if (!privateTable) {
      return res.status(httpStatus.NOT_FOUND).json({
        success: false,
        message: "Private table not found"
      });
    }

    if (privateTable.password && privateTable.password !== password) {
      return res.status(httpStatus.UNAUTHORIZED).json({
        success: false,
        message: "Invalid password"
      });
    }

    // Use the same service as socket handler
    const result = await privateTableService.registerPlayer(tableId, userId);

    res.json({
      success: true,
      data: {
        tableId,
        registered: result.registered,
        waitlisted: result.waitlisted,
        position: result.position,
        tableStatus: result.tableStatus,
        playersRegistered: result.playersRegistered,
        spotsRemaining: result.spotsRemaining
      },
      message: result.registered ? 'Joined private table' : 'Added to waitlist'
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: error.message
    });
  }
});


/* ------------------------------------------------ */
/* START PRIVATE TABLE */
/* ------------------------------------------------ */

const startPrivateTable = catchAsync(async (req, res) => {
  const { tableId } = req.params;
  const hostId = req.user._id;

  try {
    // Use the same service as socket handler
    const result = await privateTableService.startPrivateTable(tableId, hostId);

    res.json({
      success: true,
      data: {
        tableId,
        gameType: result.privateTable.gameType,
        underlyingTableId: result.gameResult.underlyingTable?._id,
        tournamentId: result.gameResult.tournament?._id,
        message: result.message
      },
      message: 'Private table started successfully'
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: error.message
    });
  }
});

/* ------------------------------------------------ */
/* LEAVE TABLE */
/* ------------------------------------------------ */

const leavePrivateTable = catchAsync(async (req, res) => {
  const { tableId } = req.params;
  const userId = req.user._id;

  try {
    const privateTable = await privateTableService.getPrivateTable(tableId);

    if (!privateTable) {
      return res.status(httpStatus.NOT_FOUND).json({
        success: false,
        message: "Private table not found"
      });
    }

    if (privateTable.status !== "WAITING_FOR_PLAYERS") {
      return res.status(httpStatus.BAD_REQUEST).json({
        success: false,
        message: "Cannot leave after game start"
      });
    }

    // Remove player from registered players
    const updatedPlayers = privateTable.registeredPlayers.filter(
      p => p.userId?.toString() !== userId.toString()
    );

    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      tableId,
      { registeredPlayers: updatedPlayers }
    );

    res.json({
      success: true,
      data: {
        tableId,
        playersRemaining: updatedPlayers.length
      },
      message: 'Left private table successfully'
    });
  } catch (error) {
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: error.message
    });
  }
});


/* ------------------------------------------------ */
/* HOST TABLES */
/* ------------------------------------------------ */

const getHostTables = catchAsync(async (req, res) => {
  const hostId = req.user._id;
  const currentUserId = req.user?._id?.toString();
  const { status, gameType } = req.query;

  try {
    // Use the same service as socket handler
    const tables = await privateTableService.getHostTables(hostId, status);

    // Add ownership flags to each table
    const tablesWithFlags = tables.map(table => ({
      ...table,
      isTableCreatedByYou: currentUserId && table.hostId?.toString() === currentUserId,
      canStart: currentUserId && table.hostId?.toString() === currentUserId && table.status === 'READY_TO_START',
      canCancel: currentUserId && table.hostId?.toString() === currentUserId && !['COMPLETED', 'CANCELLED'].includes(table.status),
      canJoin: false // Host can't join their own table as a player
    }));

    res.json({
      success: true,
      data: tablesWithFlags
    });
  } catch (error) {
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: error.message
    });
  }
});


/* ------------------------------------------------ */
/* AVAILABLE TABLES */
/* ------------------------------------------------ */

const getAvailableTables = catchAsync(async (req, res) => {
  const { gameType, minBuyIn, maxBuyIn } = req.query;
  const currentUserId = req.user?._id?.toString();
  console.log('🔍 [getAvailableTables] Query params:', { gameType, minBuyIn, maxBuyIn });

  try {
    const filter = {
      status: "WAITING_FOR_PLAYERS"
    };

    // Only add password filter if we want to exclude password-protected tables
    // For now, let's include all tables
    // filter.password = { $exists: false };

    if (gameType) {
      // Map the new gameType values to legacy values for database compatibility
      const gameTypeMap = {
        'SNG': 'PRIVATE_SNG',
        'TOURNAMENT': 'PRIVATE_TOURNAMENT'
      };
      filter.gameType = gameTypeMap[gameType] || gameType;
    }

    if (minBuyIn || maxBuyIn) {
      filter.buyIn = {};
      if (minBuyIn) filter.buyIn.$gte = Number(minBuyIn);
      if (maxBuyIn) filter.buyIn.$lte = Number(maxBuyIn);
    }

    console.log('🔍 [getAvailableTables] Filter:', filter);

    const tablesResult = await mongoHelper.find(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      filter
    );

    console.log('🔍 [getAvailableTables] Query result:', tablesResult);

    let tables = [];
    if (tablesResult.success && tablesResult.data) {
      tables = Array.isArray(tablesResult.data) ? tablesResult.data : [tablesResult.data];
    }

    // Populate host information and add ownership flags
    const populatedTables = [];
    for (const table of tables || []) {
      // Add ownership flag
      table.isTableCreatedByYou = currentUserId && table.hostId?.toString() === currentUserId;
      
      // Add additional permission flags
      table.canStart = table.isTableCreatedByYou && table.status === 'READY_TO_START';
      table.canCancel = table.isTableCreatedByYou && !['COMPLETED', 'CANCELLED'].includes(table.status);
      table.canJoin = !table.isTableCreatedByYou && table.status === 'WAITING_FOR_PLAYERS';
      
      if (table.hostId) {
        const hostResult = await mongoHelper.findById(
          mongoHelper.COLLECTIONS.USERS,
          table.hostId
        );
        
        if (hostResult.success && hostResult.data) {
          table.host = {
            username: hostResult.data.username
          };
        }
      }
      populatedTables.push(table);
    }

    res.json({
      success: true,
      data: populatedTables,
      count: populatedTables.length
    });
  } catch (error) {
    console.error('🔍 [getAvailableTables] Error:', error);
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: error.message
    });
  }
});


/* ------------------------------------------------ */
/* CANCEL TABLE */
/* ------------------------------------------------ */

const cancelTable = catchAsync(async (req, res) => {
  const { tableId } = req.params;
  const { reason } = req.body;
  const userId = req.user._id;

  try {
    // Use the same service as socket handler
    const result = await privateTableService.cancelPrivateTable(tableId, userId, reason);

    res.json({
      success: true,
      data: {
        tableId,
        cancelled: result.cancelled,
        refundAmount: result.refundAmount,
        reason: result.reason
      },
      message: 'Private table cancelled successfully'
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: error.message
    });
  }
});

/* ------------------------------------------------ */
/* GET PRIVATE TABLE BY ID */
/* ------------------------------------------------ */

const getPrivateTableById = catchAsync(async (req, res) => {
  const { privateTableId } = req.params;
  const currentUserId = req.user?._id?.toString();

  try {
    console.log('🔍 [getPrivateTableById] PrivateTableId:', privateTableId);
    
    if (!privateTableId) {
      return res.status(httpStatus.BAD_REQUEST).json({
        success: false,
        message: "Private table ID is required"
      });
    }
    
    // Get basic table data first
    const table = await privateTableService.getPrivateTable(privateTableId);

    console.log('🔍 [getPrivateTableById] Result:', table ? 'Found' : 'Not found');

    if (!table) {
      return res.status(httpStatus.NOT_FOUND).json({
        success: false,
        message: "Private table not found"
      });
    }

    // Add ownership flag
    console.log(currentUserId, table.hostId?.toString());
    table.isTableCreatedByYou = currentUserId && table.hostId?.toString() === currentUserId;
    
    // Add additional permission flags
    table.canStart = table.isTableCreatedByYou && table.status === 'READY_TO_START';
    table.canCancel = table.isTableCreatedByYou && !['COMPLETED', 'CANCELLED'].includes(table.status);
    table.canJoin = !table.isTableCreatedByYou && table.status === 'WAITING_FOR_PLAYERS';

    // Safely populate host information
    if (table.hostId) {
      try {
        const hostResult = await mongoHelper.findById(
          mongoHelper.COLLECTIONS.USERS,
          table.hostId
        );
        
        if (hostResult.success && hostResult.data) {
          table.host = {
            username: hostResult.data.username || 'Unknown',
            email: hostResult.data.email || ''
          };
        }
      } catch (hostError) {
        console.error('🔍 [getPrivateTableById] Host population error:', hostError);
        // Continue without host info
      }
    }

    // Safely populate registered players
    if (table.registeredPlayers && Array.isArray(table.registeredPlayers)) {
      const populatedPlayers = [];
      for (const player of table.registeredPlayers) {
        try {
          if (player && player.userId) {
            const userResult = await mongoHelper.findById(
              mongoHelper.COLLECTIONS.USERS,
              player.userId
            );
            
            if (userResult.success && userResult.data) {
              populatedPlayers.push({
                ...player,
                user: {
                  username: userResult.data.username || 'Unknown'
                }
              });
            } else {
              populatedPlayers.push(player);
            }
          } else {
            populatedPlayers.push(player || {});
          }
        } catch (playerError) {
          console.error('🔍 [getPrivateTableById] Player population error:', playerError);
          populatedPlayers.push(player || {});
        }
      }
      table.registeredPlayers = populatedPlayers;
    }

    res.json({
      success: true,
      data: table
    });
  } catch (error) {
    console.error('🔍 [getPrivateTableById] Error:', error);
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
});

module.exports = {
  createPrivateTable,
  getPrivateTable,
  getPrivateTableById,
  joinPrivateTable,
  startPrivateTable,
  leavePrivateTable,
  getHostTables,
  getAvailableTables,
  cancelTable
};