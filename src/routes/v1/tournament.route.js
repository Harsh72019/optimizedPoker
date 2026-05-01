const express = require('express');
const { tournamentController } = require('../../controllers');
const { tournamentValidation } = require('../../validations');
const validate = require('../../middlewares/validate');
const { protect: protectUser, checkEmailExistence } = require('../../controllers/auth.controller');
const { protect: protectAdmin } = require('../../controllers/admin.controller');

const router = express.Router();

router.get('/list', protectUser, checkEmailExistence, tournamentController.listTournaments);
router.get('/:id', protectUser, checkEmailExistence, validate(tournamentValidation.getTournamentById), tournamentController.getTournamentById);
router.post('/:id/register', protectUser, checkEmailExistence, validate(tournamentValidation.registerTournament), tournamentController.registerTournament);
router.delete('/:id/register', protectUser, checkEmailExistence, validate(tournamentValidation.registerTournament), tournamentController.unregisterTournament);
router.get('/:id/my-table', protectUser, checkEmailExistence, validate(tournamentValidation.getMyTableAssignment), tournamentController.getMyTableAssignment);

router.post('/create', protectAdmin, validate(tournamentValidation.createTournament), tournamentController.createTournament);
router.post('/:id/start', protectAdmin, validate(tournamentValidation.startTournament), tournamentController.startTournament);

module.exports = router;
