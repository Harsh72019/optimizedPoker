function emitSuccess(target, event, data = {}, message = '') {
    target.emit(event, {
        data: data || {},
        message: message || '',
        status: true
    });
}

function emitError(target, event, message = '') {
    target.emit(event, {
        data: {},
        message: message || '',
        status: false
    });
}

module.exports = {
    emitSuccess,
    emitError
};