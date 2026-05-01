const httpStatus = require('http-status');
const catchAsync = require('../utils/catchAsync');
const tournamentGameService = require('../services/tournament-game.service');

const createTournament = catchAsync(async (req, res) => {
  const adminId = req.admin?._id || req.user?._id || null;
  const tournament = await tournamentGameService.createTournament(req.body, adminId);

  res.status(httpStatus.CREATED).json({
    status: true,
    message: 'Tournament created successfully',
    data: tournament,
  });
});

const listTournaments = catchAsync(async (req, res) => {
  const tournaments = await tournamentGameService.listTournaments(req.query);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Tournaments fetched successfully',
    data: tournaments,
  });
});

const getTournamentById = catchAsync(async (req, res) => {
  const tournament = await tournamentGameService.getTournament(req.params.id);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Tournament fetched successfully',
    data: tournament,
  });
});

const registerTournament = catchAsync(async (req, res) => {
  const registration = await tournamentGameService.registerPlayer(req.params.id, req.user._id.toString());

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Successfully registered for tournament',
    data: registration,
  });
});

const startTournament = catchAsync(async (req, res) => {
  const adminId = req.admin?._id || req.user?._id || null;
  const result = await tournamentGameService.startTournament(req.params.id, null, adminId);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Tournament started successfully',
    data: result,
  });
});

const unregisterTournament = catchAsync(async (req, res) => {
  const result = await tournamentGameService.unregisterPlayer(req.params.id, req.user._id.toString());

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Successfully unregistered from tournament',
    data: result,
  });
});

const getMyTableAssignment = catchAsync(async (req, res) => {
  const assignment = await tournamentGameService.getPlayerTableAssignment(
    req.params.id,
    req.user._id.toString()
  );

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Tournament table assignment fetched successfully',
    data: assignment,
  });
});

module.exports = {
  createTournament,
  listTournaments,
  getTournamentById,
  registerTournament,
  unregisterTournament,
  startTournament,
  getMyTableAssignment,
};
