/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const os = require('os');
const chalk = require('chalk');

module.exports = bigFluffyWhiteCloud;

function bigFluffyWhiteCloud() {
  const clouds = '  ☁ ☁ ☁  ';
  const line1 = 'Artillery Cloud is coming soon';
  const line2 = 'Want early access? Head over to https://artillery.io/cloud';

  console.log(
    chalk.bgBlue.white(
      // Not everybody gets emojis 😿
      likelyToHaveEmoji() ? '☀️' : '',
      likelyToHaveEmoji() ? clouds : '',
      line1,
      likelyToHaveEmoji() ? clouds : ''),
    '\n\n',
    line2,
    '\n'
    );
}

function likelyToHaveEmoji() {
  return os.platform() === 'darwin' || os.platform === 'win32';
}
