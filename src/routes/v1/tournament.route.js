const express = require('express');
const {tournamentController} = require('../../controllers');
const {tournamentValidation} = require('../../validations');
const validate = require('../../middlewares/validate');
const {protect} = require('../../controllers/admin.controller');
const router = express.Router();

// Admin routes (protected)
router.use(protect); // Middleware to ensure admin authentication
router.post('/create', validate(tournamentValidation.createTournament), tournamentController.createTournament);
router.post(
  '/previewTournamentProgression',
  validate(tournamentValidation.previewTournamentProgression),
  tournamentController.previewTournamentProgression
);
router.get('/list', tournamentController.listTournaments);
router.get('/:id', tournamentController.getTournamentById);
router.patch('/:id', validate(tournamentValidation.updateTournament), tournamentController.updateTournament);
router.delete('/:id', validate(tournamentValidation.deleteTournament), tournamentController.deleteTournament);

module.exports = router;
