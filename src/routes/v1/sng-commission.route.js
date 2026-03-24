const express = require('express');
const { protect } = require('../../controllers/auth.controller');
const validate = require('../../middlewares/validate');
const sngCommissionController = require('../../controllers/sng-commission.controller');

const router = express.Router();

router
  .route('/preview')
  .post(protect, sngCommissionController.getSNGCommissionPreview);

module.exports = router;