const httpStatus = require('http-status');
const catchAsync = require('../utils/catchAsync');
const financialService = require('../services/financial.service');
const commissionPreviewService = require('../services/commission-preview.service');
const rakeTierService = require('../services/rake-tier.service');
const cashGameRakeService = require('../services/cash-game-rake.service');
const trustedHostService = require('../services/trusted-host.service');
const officialTournamentService = require('../services/official-tournament.service');
const walletIntegrationService = require('../services/wallet-integration.service');
const mongoHelper = require('../models/customdb');

/**
 * Generate financial preview for table creation
 */
const generatePreview = catchAsync(async (req, res) => {
  const preview = await financialService.generateFinancialPreview(req.body);
  res.status(httpStatus.OK).json({
    success: true,
    data: preview
  });
});

/**
 * Create private table with financial setup
 */
const createPrivateTable = catchAsync(async (req, res) => {
  const hostId = req.user.id; // Assuming auth middleware sets req.user
  const result = await financialService.createPrivateTable(hostId, req.body);
  
  res.status(httpStatus.CREATED).json({
    success: true,
    data: result
  });
});

/**
 * Settle game finances
 */
const settleGame = catchAsync(async (req, res) => {
  const { gameId } = req.params;
  const result = await financialService.settleGame(gameId, req.body);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Get game financial summary
 */
const getGameSummary = catchAsync(async (req, res) => {
  const { gameId } = req.params;
  const summary = await financialService.getGameFinancialSummary(gameId);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: summary
  });
});

/**
 * Get platform revenue summary
 */
const getRevenueSummary = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;
  const summary = await financialService.getPlatformRevenueSummary({ startDate, endDate });
  
  res.status(httpStatus.OK).json({
    success: true,
    data: summary
  });
});

/**
 * Get all rake tiers
 */
const getRakeTiers = catchAsync(async (req, res) => {
  const tiers = await rakeTierService.getAllTiers();
  
  res.status(httpStatus.OK).json({
    success: true,
    data: tiers
  });
});

/**
 * Get tournament rake by tier
 */
const getTournamentRake = catchAsync(async (req, res) => {
  const { tier } = req.params;
  const rake = await rakeTierService.getTournamentRake(parseInt(tier));
  
  res.status(httpStatus.OK).json({
    success: true,
    data: { tier: parseInt(tier), rake }
  });
});

/**
 * Get SNG rake by tier
 */
const getSNGRake = catchAsync(async (req, res) => {
  const { tier } = req.params;
  const rake = await rakeTierService.getSNGRake(parseInt(tier));
  
  res.status(httpStatus.OK).json({
    success: true,
    data: { tier: parseInt(tier), rake }
  });
});

/**
 * Generate cash game commission preview
 */
const getCashGamePreview = catchAsync(async (req, res) => {
  const preview = await commissionPreviewService.generateCashGamePreview(req.body);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: preview
  });
});

/**
 * Generate tournament commission preview
 */
const getTournamentPreview = catchAsync(async (req, res) => {
  const preview = await commissionPreviewService.generateTournamentPreview(req.body);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: preview
  });
});

// Admin endpoints

/**
 * Get admin configuration
 */
const getAdminConfig = catchAsync(async (req, res) => {
  const { configType } = req.params;
  const configResult = await mongoHelper.findOne(
    mongoHelper.COLLECTIONS.ADMIN_CONFIG,
    'configType',
    configType.toUpperCase()
  );
  
  if (!configResult.success || !configResult.data) {
    return res.status(httpStatus.NOT_FOUND).json({
      success: false,
      message: 'Configuration not found'
    });
  }
  
  res.status(httpStatus.OK).json({
    success: true,
    data: configResult.data
  });
});

/**
 * Update admin configuration
 */
const updateAdminConfig = catchAsync(async (req, res) => {
  const { configType } = req.params;
  const adminId = req.user.id;
  const configResult = await mongoHelper.findOne(
    mongoHelper.COLLECTIONS.ADMIN_CONFIG,
    'configType',
    configType.toUpperCase()
  );

  let savedConfig;

  if (!configResult.success || !configResult.data) {
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: configType.toUpperCase(),
      config: req.body,
      lastUpdatedBy: adminId,
      version: 1
    });

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    savedConfig = createResult.data;
  } else {
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.ADMIN_CONFIG,
      configResult.data._id,
      {
        config: { ...configResult.data.config, ...req.body },
        lastUpdatedBy: adminId,
        version: Number(configResult.data.version || 0) + 1
      }
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    savedConfig = updateResult.data;
  }
  
  res.status(httpStatus.OK).json({
    success: true,
    data: savedConfig
  });
});

/**
 * Update rake tier configuration
 */
const updateRakeTiers = catchAsync(async (req, res) => {
  const { tierType } = req.params; // 'tournament', 'sng', or 'official'
  const adminId = req.user.id;
  
  const config = await rakeTierService.updateTierConfiguration(tierType, req.body, adminId);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: config
  });
});

/**
 * Initialize default configurations
 */
const initializeConfigs = catchAsync(async (req, res) => {
  const result = await financialService.initializeDefaultConfigurations();
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Validate host uplift
 */
const validateHostUplift = catchAsync(async (req, res) => {
  const hostId = req.user.id;
  const { upliftPercent } = req.body;
  
  const isValid = await rakeTierService.validateHostUplift(hostId, upliftPercent);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: { valid: isValid }
  });
});

// Cash Game Endpoints

/**
 * Get cash game rake summary for table
 */
const getCashGameRakeSummary = catchAsync(async (req, res) => {
  const { tableId } = req.params;
  const { startDate, endDate } = req.query;
  
  const summary = await cashGameRakeService.getTableRakeSummary(tableId, { startDate, endDate });
  
  res.status(httpStatus.OK).json({
    success: true,
    data: summary
  });
});

/**
 * Get cash game rake configuration
 */
const getCashGameRakeConfig = catchAsync(async (req, res) => {
  const config = await cashGameRakeService.getCashGameRakeConfig();
  
  res.status(httpStatus.OK).json({
    success: true,
    data: config
  });
});

// Trusted Host Endpoints

/**
 * Get host type and privileges
 */
const getHostPrivileges = catchAsync(async (req, res) => {
  const hostId = req.user.id;
  const privileges = await trustedHostService.getHostPrivileges(hostId);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: privileges
  });
});

/**
 * Get host statistics
 */
const getHostStatistics = catchAsync(async (req, res) => {
  const { hostId } = req.params;
  const stats = await trustedHostService.getHostStatistics(hostId);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: stats
  });
});

/**
 * Promote host to trusted (admin only)
 */
const promoteToTrusted = catchAsync(async (req, res) => {
  const { hostId } = req.params;
  const { reason } = req.body;
  const adminId = req.user.id;
  
  const result = await trustedHostService.promoteToTrusted(hostId, adminId, reason);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Revoke trusted status (admin only)
 */
const revokeTrustedStatus = catchAsync(async (req, res) => {
  const { hostId } = req.params;
  const { reason } = req.body;
  const adminId = req.user.id;
  
  const result = await trustedHostService.revokeTrustedStatus(hostId, adminId, reason);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Get all trusted hosts (admin only)
 */
const getAllTrustedHosts = catchAsync(async (req, res) => {
  const trustedHosts = await trustedHostService.getAllTrustedHosts();
  
  res.status(httpStatus.OK).json({
    success: true,
    data: trustedHosts
  });
});

// Official Tournament Endpoints

/**
 * Create official tournament (admin only)
 */
const createOfficialTournament = catchAsync(async (req, res) => {
  const adminId = req.user.id;
  const result = await officialTournamentService.createOfficialTournament(req.body, adminId);
  
  res.status(httpStatus.CREATED).json({
    success: true,
    data: result
  });
});

/**
 * Start official tournament (admin only)
 */
const startOfficialTournament = catchAsync(async (req, res) => {
  const { tournamentId } = req.params;
  const adminId = req.user.id;
  
  const result = await officialTournamentService.startOfficialTournament(tournamentId, adminId);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Cancel official tournament (admin only)
 */
const cancelOfficialTournament = catchAsync(async (req, res) => {
  const { tournamentId } = req.params;
  const { reason } = req.body;
  const adminId = req.user.id;
  
  const result = await officialTournamentService.cancelOfficialTournament(tournamentId, adminId, reason);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Get official tournament statistics
 */
const getOfficialTournamentStats = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;
  const stats = await officialTournamentService.getOfficialTournamentStats({ startDate, endDate });
  
  res.status(httpStatus.OK).json({
    success: true,
    data: stats
  });
});

/**
 * Get all official tournaments
 */
const getAllOfficialTournaments = catchAsync(async (req, res) => {
  const tournaments = await officialTournamentService.getAllOfficialTournaments(req.query);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: tournaments
  });
});

// Wallet Endpoints

/**
 * Get user balance
 */
const getUserBalance = catchAsync(async (req, res) => {
  const userId = req.user._id?.toString?.() || req.user.id;
  const balance = await walletIntegrationService.getUserBalance(userId);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: balance
  });
});

/**
 * Get user transaction history
 */
const getUserTransactions = catchAsync(async (req, res) => {
  const userId = req.user._id?.toString?.() || req.user.id;
  const result = await financialService.getUserTransactionHistory(userId, req.query);

  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

/**
 * Add funds to user (admin only)
 */
const addFunds = catchAsync(async (req, res) => {
  const { userId, amount, description } = req.body;
  const result = await walletIntegrationService.addFunds(userId, amount, description);
  
  res.status(httpStatus.OK).json({
    success: true,
    data: result
  });
});

module.exports = {
  generatePreview,
  createPrivateTable,
  settleGame,
  getGameSummary,
  getRevenueSummary,
  getRakeTiers,
  getTournamentRake,
  getSNGRake,
  getCashGamePreview,
  getTournamentPreview,
  getAdminConfig,
  updateAdminConfig,
  updateRakeTiers,
  initializeConfigs,
  validateHostUplift,
  // Cash Game
  getCashGameRakeSummary,
  getCashGameRakeConfig,
  // Trusted Host
  getHostPrivileges,
  getHostStatistics,
  promoteToTrusted,
  revokeTrustedStatus,
  getAllTrustedHosts,
  // Official Tournament
  createOfficialTournament,
  startOfficialTournament,
  cancelOfficialTournament,
  getOfficialTournamentStats,
  getAllOfficialTournaments,
  // Wallet
  getUserBalance,
  getUserTransactions,
  addFunds
};
