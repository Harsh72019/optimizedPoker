// admin.model.js
const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    reset_token: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

const Admin = mongoose.model('Admin', adminSchema);
module.exports = { Admin };