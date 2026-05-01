const verifyEventToken = require('../verify-event-token');
const { emitSuccess, emitError } = require('../socket-emitter');
const tournamentGameService = require('../../services/tournament-game.service');

class TournamentHandler {
  constructor(io, socket) {
    this.io = io;
    this.socket = socket;
    this.registerEvents();
  }

  registerEvents() {
    this.socket.on('joinTournamentLobby', this.handleJoinTournamentLobby.bind(this));
    this.socket.on('getTournamentTableAssignment', this.handleGetTournamentTableAssignment.bind(this));
  }

  async handleJoinTournamentLobby(data) {
    try {
      const { token, tournamentId } = data;
      const user = await verifyEventToken(token, this.socket);
      this.socket.user = user;
      this.socket.join(`user_${user._id.toString()}`);
      this.socket.join(`tournament_${tournamentId}`);

      emitSuccess(this.socket, 'tournamentLobbyJoined', { tournamentId }, 'Joined tournament lobby');
    } catch (error) {
      emitError(this.socket, 'joinTournamentLobbyError', error.message);
    }
  }

  async handleGetTournamentTableAssignment(data) {
    try {
      const { token, tournamentId } = data;
      const user = await verifyEventToken(token, this.socket);
      this.socket.user = user;
      this.socket.join(`user_${user._id.toString()}`);

      const assignment = await tournamentGameService.getPlayerTableAssignment(
        tournamentId,
        user._id.toString()
      );

      emitSuccess(this.socket, 'tournamentTableAssignment', assignment, 'Tournament table assignment');
    } catch (error) {
      emitError(this.socket, 'tournamentTableAssignmentError', error.message);
    }
  }

}

module.exports = TournamentHandler;
