'use strict';

const Homey = require('homey');

class YaleBleApp extends Homey.App {

  async onInit() {
    this.log('Yale Local Bluetooth started');
  }

}

module.exports = YaleBleApp;
