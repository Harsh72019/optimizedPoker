const express = require("express");

const validate = require("../../middlewares/validate");
// const auth = require("../../middlewares/auth");

const privateTableValidation = require("../../validations/private-table.validation");
const privateTableController = require("../../controllers/private-table.controller");

const router = express.Router();

/* ------------------------------------------------ */
/* CREATE + LIST AVAILABLE TABLES */
/* ------------------------------------------------ */

router
  .route("/")
  .post(
    // auth(),
    validate(privateTableValidation.createPrivateTable),
    privateTableController.createPrivateTable
  )
  .get(
    // auth(),
    validate(privateTableValidation.getAvailableTables),
    privateTableController.getAvailableTables
  );


/* ------------------------------------------------ */
/* HOST TABLES */
/* ------------------------------------------------ */

router.get(
  "/host",
//   auth(),
  validate(privateTableValidation.getHostTables),
  privateTableController.getHostTables
);


/* ------------------------------------------------ */
/* TABLE DETAILS */
/* ------------------------------------------------ */

router.get(
  "/:tableId",
//   auth(),
  validate(privateTableValidation.getPrivateTable),
  privateTableController.getPrivateTable
);


/* ------------------------------------------------ */
/* JOIN TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/join",
//   auth(),
  validate(privateTableValidation.joinPrivateTable),
  privateTableController.joinPrivateTable
);


/* ------------------------------------------------ */
/* LEAVE TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/leave",
//   auth(),
  validate(privateTableValidation.leavePrivateTable),
  privateTableController.leavePrivateTable
);


/* ------------------------------------------------ */
/* COMPLETE GAME (ENGINE / ADMIN) */
/* ------------------------------------------------ */

router.post(
  "/:tableId/complete",
//   auth(),
  validate(privateTableValidation.completeGame),
  privateTableController.completeGame
);


/* ------------------------------------------------ */
/* CANCEL TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/cancel",
//   auth(),
  validate(privateTableValidation.cancelTable),
  privateTableController.cancelTable
);


module.exports = router;