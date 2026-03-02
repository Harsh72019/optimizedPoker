// src/websocket/middleware/auth.middleware.js

const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const mongoHelper = require('../../models/customdb');

class AuthMiddleware {
  static async verifyToken(socket, next) {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, config.JWT_SECRET);
      
      const userResult = await mongoHelper.findById(
        mongoHelper.COLLECTIONS.USERS,
        decoded.userId || decoded._id || decoded.id
      );

      if (!userResult.success || !userResult.data) {
        return next(new Error('User not found'));
      }

      socket.user = {
        _id: userResult.data._id,
        username: userResult.data.username,
        email: userResult.data.email
      };

      next();
    } catch (err) {
      next(new Error('Invalid token: ' + err.message));
    }
  }
}

module.exports = AuthMiddleware;