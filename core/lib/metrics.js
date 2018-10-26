/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

/*
 *
 * An implementation of a store of timestamped events which may be
 * aggregated into a variety of common metric types, with support for
 * custom flushing and aggregation mechanisms.
 *
 */

const driftless = require('driftless');
const debug = require('debug')('metrics');
const debugV = require('debug')('metrics:verbose');
const uuid = require('uuid').v4;
const _ = require('lodash');
const HdrHistogram = require('hdr-histogram-js');
const EventEmitter = require('events');

class Metrics {
  constructor(opts) {
    opts = Object.assign({}, opts);
    this._aggregationIntervalMs = (opts.aggregationInterval || 10) * 1000;
    this._aggregationLagMs = (opts.aggregationLag || 10) * 1000;

    this._events = {};
    this._eventTypes = {};
    this._eventNames = {};
    this._timers = {};
    this._periods = [];

    this.events = new EventEmitter();

    const aggregator = (opts.aggregator || defaultAggregator).bind(this);

    this._aggregateInterval = driftless.setDriftlessInterval(() => {
      aggregator(() => {});
    }, Math.floor(this._aggregationIntervalMs * 1.5));

    if (typeof opts.flusher === 'function') {
      this.opts.flusher = opts.flusher;
      this._flush(() => {});
    }
    this._flushing = false;

    return this;
  }

  free() {
    driftless.clearDriftless(this._aggregateInterval);
    return this;
  }

  // Options: counter, histogram, meter, watermark
  // The usage of describeMetric is optional (to provide a display name
  // if needed). Tracking metrics that haven't been pre-declared will
  // still work (in cases when we don't have the final list of metric names,
  // e.g. when tracking error codes in an engine, or the occurence of
  // HTTP response codes).
  describeMetric(name, type) {
    let metricDefinitions = [];
    if (typeof name === 'object') {
      metricDefinitions = metricDefinitions.concat(name);
    } else {
      metricDefinitions = metricDefinitions.concat({ name, type });
    }

    metricDefinitions.forEach(o => {
      if (o.type === 'watermark') {
        this._timers[o.name] = [];
      } else {
        this._events[o.name] = [];
      }

      this._eventTypes[o.name] = o.type;
      this._eventNames[o.name] = o.displayName || o.name;
    });

    return this;
  }

  describeMetrics(list) {
    return this.describeMetric(list);
  }

  event(name, value = 1, tags = {}) {
    if (!this._events.hasOwnProperty(name)) {
      this._events[name] = [];
    }

    this._events[name].push({
      ts: Date.now(),
      v: value,
      tags: tags
    });
    return this;
  }

  // Relying on event stream being ordered by timestamp - not
  // necessarily guaranteed when several streams for the same
  // event are merged, unless we sort when we merge.
  // TODO: Consider a sorted array with binary insert.

  listEvents() {
    return Object.keys(this._events);
  }

  getEventDisplayName(name) {
    return this._eventNames[name];
  }

  getEventData(name, gte, lte) {
    // TODO: Don't need to scan the entire array - once we reach
    // a timestamp that's greater than lte we can stop.
    return this._events[name].filter(e => {
      return e.ts >= gte && e.ts <= lte;
    });
  }

  getTimerData(name, lte, gte) {
    return this._timers[name].filter(e => {
      return e.ts >= gte && e.ts <= lte;
    });
  }

  deleteEventData(name, gte, lte) {
    // Super-naive implementation; presumes that the event stream is sorted by ts field (ascending).
    this._events[name] = this._events[name].filter(e => e.ts > lte);
    return this;
  }

  deleteTimerData(name, gte, lte) {
    // Delete everything, then insert sats. Loss of timing information does not matter for current use case (and is impossible withoud IDs anyway).

    // Could track these at the point of insertion to optimize.
    const stats = this._timers[name].reduce(
      (acc, e) => {
        if (e.eat && e.eat <= lte && e.eat >= gte) acc.eats++;
        if (e.sat && e.sat <= lte && e.sat >= gte) acc.sats++;
        return acc;
      },
      {
        sats: 0,
        eats: 0
      }
    );

    this._timers[name] = this._timers[name].filter((e) => {
      if (e.eat && e.eat <= lte && e.eat >= gte) return true;
      if (e.sat && e.sat <= lte && e.sat >= gte) return true;
    });

    if (stats.sats > stats.eats) {
      this._timers[name] = [].concat(this._timers[name]);
    }

    // if (stats.sats < stats.eats)
  }

  getEventType(name) {
    return this._eventTypes[name];
  }

  // Only called if opts.flusher is set
  _flush(cb) {
    debug('_flush()');
    if (!this._flushing) {
      this._flushing = true;

      // TODO: call custom flusher here.

      this._flushing = false;
    }

    driftless.setDriftlessTimeout(
      this._flusher.bind(this),
      Math.floor(this._aggregationIntervalMs / 4)
    );

    return cb(null);
  }

  getEarliestEventTimestamp() {
    const ts = Object.keys(this._events).map(e => {
      if (this._events[e].length === 0) {
        return Infinity;
      } else {
        return this._events[e][0].ts;
      }
    });

    let min = Infinity;
    ts.forEach(t => {
      min = Math.min(min, t);
    });

    return min;
  }

  meter(name) {
    return this.event(name);
  }

  histogram(name, value) {
    return this.event(name, value);
  }

  counter(name, value = 1) {
    return this.event(name, value);
  }

  markStart(name, id) {
    if (!this._timers.hasOwnProperty(name)) {
      this._timers[name] = [];
    }
    return this._timers[name].push([{ sat: Date.now(), id: id }]);
  }

  markEnd(name, id) {
    if (!this._timers.hasOwnProperty(name)) {
      this._timers[name] = [];
    }

    return this._timers[name].push([{ eat: Date.now(), id: id }]);
  }

  listPeriods(cb) {
    if (!cb) {
      return new Promise(resolve => {
        resolve(this._periods.map(p => p.id));
      });
    } else {
      return cb(null, this._periods.map(p => p.id));
    }
  }

  getPeriod(id, cb) {
    const period = _.find(this._periods, p => p.id === id);

    if (!cb) {
      return new Promise(resolve => {
        resolve(period);
      });
    } else {
      return cb(null, period);
    }
  }

  getLastPeriod(cb) {
    return cb(null, {});
  }
}

function create() {
  return new Metrics({});
}

// NOTE: Won't combine aggregated periods.
function merge(metricStreams) {
  return metricStreams;
}

function defaultAggregator(cb) {
  // "this" is a Metrics instance

  const earliest =
    this._nextPeriodBeginning || this.getEarliestEventTimestamp();
  if (earliest === Infinity) {
    debug('defaultAggregator - no events recorded yet');
    return cb(null);
  }

  const latest = earliest + this._aggregationIntervalMs;
  const withLag = latest + this._aggregationLagMs;

  debug(
    `defaultAggregator\n- earliest: ${earliest} / ${new Date(
      earliest
    )}\n- latest: ${latest} / ${new Date(
      latest
    )}\n- with lag: ${withLag} / ${new Date(
      withLag
    )}\n- now: ${Date.now()} / ${new Date()}`
  );

  if (withLag > Date.now()) {
    debug('defaultAggregator - skipping');
    return cb(null);
  } else {
    debug('defaultAggregator - aggregating');
  }

  this._nextPeriodBeginning = latest + 1;

  const period = {
    id: uuid(),
    startsAt: earliest,
    endsAt: latest,
    metrics: {}
  };

  //
  // Aggregate events for counters, meters and histograms:
  //
  this.listEvents().forEach(name => {
    const eventType = this.getEventType(name);
    const eventStream = this.getEventData(name, earliest, latest);

    if (eventType === 'counter') {
      const value = _.sum(_.map(eventStream, 'v'));
      period.metrics[name] = {
        type: eventType,
        value: value
      };
    } else if (eventType === 'meter') {
      const value = round(
        eventStream.length / (this._aggregationIntervalMs / 1000),
        2
      );
      period.metrics[name] = {
        type: eventType,
        value: value,
        unit: 'second'
      };
    } else if (eventType === 'histogram') {
      const h = HdrHistogram.build({
        bitBucketSize: 64,
        autoResize: true,
        lowestDiscernibleValue: 2,
        highestTrackableValue: 1e12,
        numberOfSignificantValueDigits: 2
      });
      eventStream.forEach(e => {
        debugV(`Recording ${e.v} in histogram for metric ${name}`);
        h.recordValue(e.v);
      });
      period.metrics[name] = {
        type: eventType,
        value: {
          min: round(h.minNonZeroValue, 2),
          max: round(h.maxValue, 2),
          median: round(h.getValueAtPercentile(50), 2),
          p95: round(h.getValueAtPercentile(95), 2),
          p99: round(h.getValueAtPercentile(99), 2)
        }
      };
    }

    this.deleteEventData(name, earliest, latest);
  });

  //
  // Aggregate watermarks:
  //
  Object.keys(this._timers).forEach(name => {
    let high = 0;
    let c = 0;
    const eventStream = this.getTimerData(name, earliest, latest);

    eventStream.forEach(e => {
      if (e.sat) {
        c++;
        if (c > high) {
          high = c;
        }
      } else if (e.eat) {
        c--;
      }
    });

    period[name] = {
      type: 'watermark',
      value: high
    };

    this.deleteTimerData(name, earliest, latest);
  });

  this._periods.push(period);
  this.events.emit('aggregate', period);
  return cb(null);
}

function round(number, decimals) {
  const m = Math.pow(10, decimals);
  return Math.round(number * m) / m;
}

module.exports = {
  Metrics,
  create,
  merge,
  round
};
