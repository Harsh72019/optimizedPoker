const dummyTournament = {
  _id: 'dummy-tournament-2026-05-10',
  name: 'May 10 Frontend Test Tournament',
  description: 'Dummy scheduled tournament for frontend integration testing.',
  startTime: '2026-05-10T15:00:00.000Z',
  registrationDeadline: '2026-05-10T14:30:00.000Z',
  status: 'registering',
  maxPlayers: 90,
  minPlayersPerTable: 2,
  maxPlayersPerTable: 9,
  buyIn: 25,
  currentLevel: {
    levelNumber: 1,
    smallBlind: 50,
    bigBlind: 100,
    ante: 0,
    startedAt: '2026-05-10T15:00:00.000Z',
  },
  levelStartTime: '2026-05-10T15:00:00.000Z',
  payoutStructure: [
    { position: 1, percentage: 50 },
    { position: 2, percentage: 30 },
    { position: 3, percentage: 20 },
  ],
  players: [],
  waitlist: [],
  activeTables: [],
  underlyingTables: [],
  prizePool: 0,
  winners: [],
  levelDuration: 15,
  tournamentDuration: 0,
  timeZone: 'Asia/Kolkata',
  generatedBlindLevels: [
    { levelNumber: 1, smallBlind: 50, bigBlind: 100, ante: 0, duration: 15 },
    { levelNumber: 2, smallBlind: 75, bigBlind: 150, ante: 0, duration: 15 },
    { levelNumber: 3, smallBlind: 100, bigBlind: 200, ante: 25, duration: 15 },
    { levelNumber: 4, smallBlind: 150, bigBlind: 300, ante: 25, duration: 15 },
    { levelNumber: 5, smallBlind: 200, bigBlind: 400, ante: 50, duration: 15 },
  ],
  startingChips: 10000,
  isOfficial: true,
  isPrivate: false,
  rakePercentage: 6,
  timerSeconds: 20,
  nextEliminationPosition: 0,
  fixture: true,
  frontendNote: 'Read-only dummy data. Create a real tournament to test registration/start flows.',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

function matchesTournamentFilters(filters = {}) {
  return !filters.status || filters.status === dummyTournament.status;
}

module.exports = {
  dummyTournament,
  DUMMY_TOURNAMENT_ID: dummyTournament._id,
  matchesTournamentFilters,
};
