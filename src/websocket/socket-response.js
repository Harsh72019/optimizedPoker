// src/websocket/socket-response.js

class SocketResponse {
    static success(socket, event, data = null, message = null) {
        socket.emit(event, {
            success: true,
            data,
            message
        });
    }

    static error(socket, event, message, code = null) {
        socket.emit(event, {
            success: false,
            error: message,
            code
        });
    }

    static broadcast(io, room, event, data = null) {
        io.to(room).emit(event, {
            success: true,
            data
        });
    }
}

module.exports = SocketResponse;
