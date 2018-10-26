'use strict';

const test = require('ava');
const { Metrics } = require('./metrics');
const createDebug = require('debug');

const debug = createDebug('test:metrics');

const M = {
  requestCount: 'engine.http.request.count',
  code200: 'engine.http.response.code.200',
  responseTime: 'engine.http.response.time',
  ops: 'engine.http.response.rate',
  concurrency: 'engine.http.request.concurrency'
};

test('Basic tracking of a couple of metrics', async t => {
  const m = new Metrics({
    aggregationInterval: 2,
    aggregationLag: 2
  });

  m.describeMetric(M.requestCount, 'counter');
  m.describeMetric(M.code200, 'counter');
  m.describeMetric(M.responseTime, 'histogram');
  m.describeMetric(M.ops, 'meter');

  m.counter(M.requestCount);
  m.counter(M.requestCount, 2);

  m.meter(M.ops);
  m.meter(M.ops);

  for (let i = 1; i < 100; i++) {
    m.histogram(M.responseTime, Math.ceil(Math.random() * 1000));
  }

  return new Promise(function(resolve, reject) {
    setTimeout(function() {
      const periods = m.listPeriods((err, periodIds) => {
        t.true(
          periodIds.length > 0,
          `Have some aggregated periods (${periodIds.length})`
        );

        m.getPeriod(periodIds[0]).then(period => {
          debug(JSON.stringify(period, null, 4));

          // Basic checks on the counter:
          t.true(
            period.metrics[M.requestCount].type === 'counter',
            `${M.requestType} has correct aggregation type`
          );
          t.is(
            period.metrics[M.requestCount].value,
            3,
            `${M.requestType} has correct value of ${3}`
          );
          // Basic checks on the histogram:
          t.true(typeof period.metrics[M.responseTime].value.min === 'number');
          t.true(period.metrics[M.responseTime].value.p95 > 0);

          // Basic checks on the meter:
          t.true(period.metrics[M.ops].value > 0);

          // A metric of type counter for which no events were recorded in a period should have a value of zero:
          t.is(period.metrics[M.code200].value, 0);
          resolve();
        });
      });
    }, 10 * 1000);
  });
});

test('Continuous tracking of a couple of metrics', async t => {
  const m = new Metrics();

  m.describeMetrics([
    { name: M.requestCount, type: 'counter', displayName: 'Requests sent' },
    { name: M.responseTime, type: 'histogram', displayName: 'Response times' }
  ]);
  m.describeMetrics(M.code200, 'counter');
  m.describeMetric(M.ops, 'meter');

  m.events.on('aggregate', period => {
    debug(JSON.stringify(period, null, 4));
    t.true(typeof period.metrics[M.responseTime].value.min === 'number');
    t.true(period.metrics[M.responseTime].value.p95 > 0);
    t.true(period.metrics[M.responseTime].value.max >= 4000);
    t.true(period.metrics[M.ops].value > 5);
    t.is(period.metrics[M.ops].type, 'meter');
    t.true(period.metrics[M.requestCount].value >= 28);
  });

  return new Promise((resolve, reject) => {
    setInterval(function trackSomeEvents() {
      // 1e4 / 350 * 2 ~= 56 in a 10 second period, so the aggregated rate/sec should be >5
      m.meter(M.ops);
      m.meter(M.ops);
      // Similarly expecting aggregated count to be >= 28
      m.counter(M.requestCount);

      // 1e4 / 350 * 25 ~= 714
      for (let i = 1; i < Math.ceil(Math.random() * 25); i++) {
        m.histogram(M.responseTime, Math.ceil(Math.random() * 3000));
        m.histogram(M.responseTime, 4000);
      }
    }, 350).unref();

    setInterval(function blackboxCheck() {
      // Check that we never have more events in the streams than we expect, i.e. that raw events
      // are being removed once they have been aggregated or flushed.
      let eventCount = 0;
      Object.keys(m._events).forEach((metric) => {
        eventCount += m._events[metric].length;
      });
      t.true(eventCount <= 715 + 57 + 28);
    }, 20 * 1000).unref();

    setTimeout(() => {
      resolve();
    }, 120 * 1000);
  });
});

// test('Watermark metrics', async (t) => {
//   const m = new Metrics();

//   m.describeMetrics([
//     { name: M.concurrency, type: 'watermark', displayName: 'Concurrent requests' },
//   ]);
// });
