const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const httpStatus = require('http-status');
const morgan = require('./config/morgan');
const config = require('./config/config');
const routes = require('./routes/v1');
const ApiError = require('./utils/ApiError');
const { errorConverter, errorHandler } = require('./middlewares/error');

const app = express();

if (config.env !== 'test') {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(cors());

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.use('/v1', routes);

app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, 'Not found'));
});

app.use(errorConverter);
app.use(errorHandler);

module.exports = app;