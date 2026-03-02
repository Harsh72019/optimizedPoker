// src/websocket/verify-event-token.js

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const mongoHelper = require('../models/customdb');

async function verifyEventToken(token, socket) {
    if (!token) {
        throw new Error('No token provided');
    }

    if (socket.user && socket.cachedToken === token) {
        return socket.user;
    }

    const decoded = jwt.verify(token, config.JWT_SECRET);
    
    const userResult = await mongoHelper.findById(
        mongoHelper.COLLECTIONS.USERS,
        decoded.userId || decoded._id || decoded.id
    );

    if (!userResult.success || !userResult.data) {
        throw new Error('User not found');
    }

    const user = {
        _id: userResult.data._id,
        username: userResult.data.username,
        email: userResult.data.email
    };

    socket.user = user;
    socket.cachedToken = token;

    return user;
}

module.exports = verifyEventToken;
