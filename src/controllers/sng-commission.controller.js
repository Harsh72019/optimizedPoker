const httpStatus = require("http-status");
const catchAsync = require("../utils/catchAsync");
const sngCommissionPreview = require('../services/sng-commission-preview.service');
const financialIntegrationService = require('../services/financial-integration.service');

/* ------------------------------------------------ */
/* GET SNG COMMISSION PREVIEW */
/* ------------------------------------------------ */

const getSNGCommissionPreview = catchAsync(async (req, res) => {
  const {
    declaredCapacity,
    buyIn,
    duration,
    timerSeconds,
    tier,
    hostUplift,
    bigBlind,
    gameType
  } = req.body;

  try {
    let preview;
    
    if (gameType === 'SNG' || gameType === 'PRIVATE_SNG') {
      // Use SNG-specific commission preview
      preview = await sngCommissionPreview.generateSNGCommissionPreview({
        declaredCapacity: declaredCapacity || 6,
        buyIn: buyIn || 50,
        duration: duration || 2,
        timerSeconds: timerSeconds || 30,
        tier: tier || 3,
        hostUplift: hostUplift || 0,
        bigBlind: bigBlind || (buyIn || 50) / 25 // Estimate BB as buyIn/25
      });
    } else {
      // Use tournament preview for tournaments
      preview = await financialIntegrationService.getTableFinancialPreview(req.body);
    }

    res.json({
      success: true,
      data: preview,
      message: 'Commission preview generated successfully'
    });
  } catch (error) {
    console.error('SNG Commission Preview Error:', error);
    res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = {
  getSNGCommissionPreview
};