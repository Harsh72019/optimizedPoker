const express = require('express');
const matchmakingController = require('../../controllers/matchmaking.controller');
const { authController } = require('../../controllers');
const router = express.Router();

// router.use(auth.protect);

// router.post('/join', authController.protect, matchmakingController.joinTable);
// router.post('/tables/:tableId/leave', authController.protect, matchmakingController.leaveTable);
// router.get('/subtiers/:subTierId/queue', authController.protect, matchmakingController.getSubTierQueue);
// router.get('/tiers/:tierId/tables', authController.protect, matchmakingController.getTierTables);
router.post('/initialize', matchmakingController.initializeMatchmaking);
router.post('/process', matchmakingController.processMatchmaking);
router.delete('/cleanupTestData', matchmakingController.cleanupTestData);
router.get('/status', matchmakingController.getMatchmakingStatus);
router.get('/tiers', authController.protect , matchmakingController.getTiersWithSubTiers);

module.exports = router;