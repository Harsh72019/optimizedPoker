const express = require('express');
const validate = require('../../middlewares/validate');
const financialValidation = require('../../validations/financial.validation');
const financialController = require('../../controllers/financial.controller');

const router = express.Router();

// Public endpoints (require authentication but not admin)
router
  .route('/preview')
  .post(validate(financialValidation.generatePreview), financialController.generatePreview);

router
  .route('/preview/cash-game')
  .post(validate(financialValidation.cashGamePreview), financialController.getCashGamePreview);

router
  .route('/preview/tournament')
  .post(validate(financialValidation.tournamentPreview), financialController.getTournamentPreview);

router
  .route('/table/create')
  .post(validate(financialValidation.createPrivateTable), financialController.createPrivateTable);

router
  .route('/game/:gameId/settle')
  .post(validate(financialValidation.settleGame), financialController.settleGame);

router
  .route('/game/:gameId/summary')
  .get(validate(financialValidation.getGameSummary), financialController.getGameSummary);

router
  .route('/rake/tiers')
  .get(financialController.getRakeTiers);

router
  .route('/rake/tournament/:tier')
  .get(validate(financialValidation.getTournamentRake), financialController.getTournamentRake);

router
  .route('/rake/sng/:tier')
  .get(validate(financialValidation.getSNGRake), financialController.getSNGRake);

router
  .route('/host/validate-uplift')
  .post(validate(financialValidation.validateHostUplift), financialController.validateHostUplift);

// Cash Game endpoints
router
  .route('/cash-game/rake/summary/:tableId')
  .get(financialController.getCashGameRakeSummary);

router
  .route('/cash-game/rake/config')
  .get(financialController.getCashGameRakeConfig);

// Trusted Host endpoints
router
  .route('/host/privileges')
  .get(financialController.getHostPrivileges);

router
  .route('/host/statistics/:hostId')
  .get(financialController.getHostStatistics);

// Wallet endpoints
router
  .route('/wallet/balance')
  .get(financialController.getUserBalance);

// Official Tournament endpoints (public)
router
  .route('/tournament/official')
  .get(financialController.getAllOfficialTournaments);

router
  .route('/tournament/official/stats')
  .get(financialController.getOfficialTournamentStats);

// Admin endpoints (require admin authentication)
router
  .route('/admin/revenue/summary')
  .get(validate(financialValidation.getRevenueSummary), financialController.getRevenueSummary);

router
  .route('/admin/config/:configType')
  .get(validate(financialValidation.getAdminConfig), financialController.getAdminConfig)
  .put(validate(financialValidation.updateAdminConfig), financialController.updateAdminConfig);

router
  .route('/admin/rake/:tierType')
  .put(validate(financialValidation.updateRakeTiers), financialController.updateRakeTiers);

router
  .route('/admin/initialize')
  .post(financialController.initializeConfigs);

// Trusted Host admin endpoints
router
  .route('/admin/host/trusted')
  .get(financialController.getAllTrustedHosts);

router
  .route('/admin/host/:hostId/promote')
  .post(financialController.promoteToTrusted);

router
  .route('/admin/host/:hostId/revoke')
  .post(financialController.revokeTrustedStatus);

// Official Tournament admin endpoints
router
  .route('/admin/tournament/official')
  .post(financialController.createOfficialTournament);

router
  .route('/admin/tournament/official/:tournamentId/start')
  .post(financialController.startOfficialTournament);

router
  .route('/admin/tournament/official/:tournamentId/cancel')
  .post(financialController.cancelOfficialTournament);

// Wallet admin endpoints
router
  .route('/admin/wallet/add-funds')
  .post(financialController.addFunds);

module.exports = router;