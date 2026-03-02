const express = require('express');

const userRoute = require('./user.route');
const authRoute = require('./auth.route');
const adminRoute = require('./admin.route');
const tournamentRoute = require('./tournament.route');
const templateRoute = require('./template.route');
const tableRoute = require('./table.route');
const matchmakingRoute = require('./matchmaking.routes');

const router = express.Router();

router.use('/auth', authRoute);
router.use('/users', userRoute);
router.use('/admin', adminRoute);
router.use('/template', templateRoute);
router.use('/tournament', tournamentRoute);
router.use('/table', tableRoute);
router.use('/matchmaking', matchmakingRoute);

module.exports = router;
