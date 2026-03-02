const catchAsync = require('../utils/catchAsync');
const {tournamentService} = require('../services');
const httpStatus = require('http-status');
const {getPaginateConfig} = require('../utils/queryPHandler');

const createTournament = catchAsync(async (req, res) => {
  try {
    const tournamentData = {
      ...req.body,
      timeZone: req.body.timeZone || 'UTC', // Default to UTC if not specified
    };

    if (!tournamentData.levelDuration) {
      tournamentData.levelDuration = 15; // Default 15 minutes per level
    }

    if (!tournamentData.tournamentDuration) {
      tournamentData.tournamentDuration = 0; // 0 means no fixed duration
    }

    const tournament = await tournamentService.createTournament(tournamentData);

    res.status(httpStatus.CREATED).json({
      status: true,
      message: 'Tournament created successfully',
      data: tournament,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const listTournaments = catchAsync(async (req, res) => {
  try {
    const {status, startDate, endDate, ...otherOptions} = req.query;
    const {options} = getPaginateConfig(otherOptions);

    // Build filter object
    const filter = {};
    if (status) {
      filter.status = status;
    }
    if (startDate || endDate) {
      filter.startTime = {};
      if (startDate) filter.startTime.$gte = new Date(startDate);
      if (endDate) filter.startTime.$lte = new Date(endDate);
    }

    const tournaments = await tournamentService.listTournaments(filter, options);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Tournaments fetched successfully',
      data: tournaments,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const getTournamentById = catchAsync(async (req, res) => {
  try {
    const tournament = await tournamentService.getTournamentById(req.params.id);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Tournament fetched successfully',
      data: tournament,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const previewTournamentProgression = catchAsync(async (req, res) => {
  try {
    const tournament = await tournamentService.calculateTournamentProgression(req.body);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Preview details fetched successfully',
      data: tournament,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const updateTournament = catchAsync(async (req, res) => {
  try {
    const tournament = await tournamentService.updateTournament(req.params.id, req.body);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Tournament updated successfully',
      data: tournament,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const deleteTournament = catchAsync(async (req, res) => {
  try {
    await tournamentService.deleteTournament(req.params.id);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Tournament deleted successfully',
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

module.exports = {
  createTournament,
  listTournaments,
  getTournamentById,
  updateTournament,
  deleteTournament,
  previewTournamentProgression,
};
