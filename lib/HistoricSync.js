'use strict';

require('classtool');

function spec() {
  var util = require('util');
  var RpcClient = require('bitcore/RpcClient').class();
  var networks = require('bitcore/networks');
  var async = require('async');
  var config = require('../config/config');
  var Block = require('../app/models/Block');
  var Sync = require('./Sync').class();
  var sockets = require('../app/controllers/socket.js');

  function HistoricSync(opts) {
    this.network = config.network === 'testnet' ? networks.testnet: networks.livenet;

    var genesisHashReversed = new Buffer(32);
    this.network.genesisBlock.hash.copy(genesisHashReversed);
    this.genesis = genesisHashReversed.reverse().toString('hex');
    this.sync = new Sync(opts);

    //available status: new / syncing / finished / aborted
    this.status = 'new';
    this.syncInfo = {};
  }

  function p() {
    var args = [];
    Array.prototype.push.apply(args, arguments);

    args.unshift('[historic_sync]');
    /*jshint validthis:true */
    console.log.apply(this, args);
  }

  HistoricSync.prototype.init = function(opts, cb) {

    var self = this;
    self.rpc = new RpcClient(config.bitcoind);
    self.opts = opts;
    self.sync.init(opts, function(err) {
      if (err) {
        self.err = err.message;
        self.syncInfo = util._extend(self.syncInfo, { error: err.message });
        return cb(err);
      }
      else {
        // check testnet?
        self.rpc.getBlockHash(0, function(err, res){
          if (!err && ( res && res.result !== self.genesis)) {
            self.err = 'Bad genesis block. Network mismatch between Insight and bitcoind? Insight is configured for:' + config.network;
            err = new Error(self.err);
            self.syncInfo = util._extend(self.syncInfo, { error: err.message });
          }
          return cb(err);
        });
      }
    });

  };

  HistoricSync.prototype.close = function() {
    this.sync.close();
  };

  HistoricSync.prototype.showProgress = function() {
    var self = this;

    var i = self.syncInfo;
    var per = parseInt(100 * i.syncedBlocks / i.blocksToSync);
    p(util.format('status: %d/%d [%d%%]', i.syncedBlocks, i.blocksToSync, per));
    if (self.opts.shouldBroadcast) {
      sockets.broadcastSyncInfo(self.syncInfo);
    }
  };

  HistoricSync.prototype.getPrevNextBlock = function(blockHash, blockEnd, opts, cb) {
    var self = this;

    // recursion end.
    if (!blockHash) return cb();

    var existed = false;
    var blockInfo;
    var blockObj;

    async.series([
    // Already got it?
    function(c) {
      Block.findOne({
        hash: blockHash
      },
      function(err, block) {
        if (err) {
          p(err);
          return c(err);
        }
        if (block) {
          existed = true;
          blockObj = block;
        }
        return c();
      });
    },
    //show some (inacurate) status
    function(c) {
      if (!self.step) {
        var step = parseInt(self.syncInfo.blocksToSync / 100);
        if (self.opts.progressStep) {
          step = self.opts.progressStep;
        }
        if (step < 2) step = 2;
        self.step = step;
      }
      if (self.syncInfo.syncedBlocks % self.step === 1) {
        self.showProgress();
      }
      return c();
    },
    //get Info from RPC
    function(c) {

      // TODO: if we store prev/next, no need to go to RPC
      // if (blockObj && blockObj.nextBlockHash) return c();
      self.rpc.getBlock(blockHash, function(err, ret) {
        if (err) return c(err);

        blockInfo = ret;
        return c();
      });
    },
    //store it
    function(c) {
      if (existed) return c();
      self.sync.storeBlock(blockInfo.result, function(err) {

        existed = err && err.toString().match(/E11000/);

        if (err && ! existed) return c(err);
        return c();
      });
    },
    /* TODO: Should Start to sync backwards? (this is for partial syncs)
      function(c) {

        if (blockInfo.result.prevblockhash != current.blockHash) {
          p("reorg?");
          opts.prev = 1;
        }
        return c();
        }
      */
    ], function(err) {

      if (err) {
        self.err = util.format('ERROR: @%s: %s [count: syncedBlocks: %d]', blockHash, err, self.syncInfo.syncedBlocks);
        self.status = 'aborted';
        p(self.err);
      }

      else {
        self.err = null;
        self.status = 'syncing';
      }

      if (opts.upToExisting && existed) {
        var diff = self.syncInfo.blocksToSync - self.syncInfo.syncedBlocks;
        if (diff <= 0) {
          self.status = 'finished';
          p('DONE. Found existing block: ', blockHash);
          return cb(err);
        }
        else {
          self.syncInfo.skipped_blocks = self.syncInfo.skipped_blocks || 1;
          if ((self.syncInfo.skipped_blocks++ % 1000) === 1) {
            p('WARN found target block\n\tbut blockChain Height is still higher that ours. Previous light sync must be interrupted.\n\tWill keep syncing.', self.syncInfo.syncedBlocks, self.syncInfo.blocksToSync, self.syncInfo.skipped_blocks);
          }
        }
      }

      if (blockEnd && blockEnd === blockHash) {
        self.status = 'finished';
        p('DONE. Found END block: ', blockHash);
        return cb(err);
      }

      // Continue
      if (blockInfo && blockInfo.result) {
        if (!existed) self.syncInfo.syncedBlocks++;
        if (opts.prev && blockInfo.result.previousblockhash) {
          return self.getPrevNextBlock(blockInfo.result.previousblockhash, blockEnd, opts, cb);
        }

        if (opts.next && blockInfo.result.nextblockhash) return self.getPrevNextBlock(blockInfo.result.nextblockhash, blockEnd, opts, cb);
      }
      return cb(err);
    });
  };

  HistoricSync.prototype.import_history = function(opts, next) {
    var self = this;

    var retry_secs = 2;

    var bestBlock;
    var blockChainHeight;

    async.series([
    function(cb) {
      if (opts.destroy) {
        p('Deleting DB...');
        return self.sync.destroy(cb);
      }
      return cb();
    },
    // We are not using getBestBlockHash, because is not available in all clients
    function(cb) {
      if (!opts.reverse) return cb();

      self.rpc.getBlockCount(function(err, res) {
        if (err) return cb(err);
        blockChainHeight = res.result;
        return cb();
      });
    },
    function(cb) {
      if (!opts.reverse) return cb();

      self.rpc.getBlockHash(blockChainHeight, function(err, res) {
        if (err) return cb(err);

        bestBlock = res.result;

        return cb();
      });
    },
    function(cb) {
      // This is only to inform progress.
      if (!opts.upToExisting) {
        self.rpc.getInfo(function(err, res) {
          if (err) return cb(err);
          self.syncInfo.blocksToSync = res.result.blocks;
          return cb();
        });
      }
      else {
        // should be isOrphan = true or null to be more accurate.
        Block.count({
          isOrphan: null
        },
        function(err, count) {
          if (err) return cb(err);

          self.syncInfo.blocksToSync = blockChainHeight - count;
          if (self.syncInfo.blocksToSync < 1) self.syncInfo.blocksToSync = 1;
          return cb();
        });
      }
    },
    ], function(err) {

      var start, end;
      function sync() {
        if (opts.reverse) {
          start = bestBlock;
          end = self.genesis;
          opts.prev = true;
        }
        else {
          start = self.genesis;
          end = null;
          opts.next = true;
        }

        self.syncInfo = util._extend(self.syncInfo, {
          start: start,
          isStartGenesis: start === self.genesis,
          end: end,
          isEndGenesis: end === self.genesis,
          scanningForward: opts.next,
          scanningBackward: opts.prev,
          upToExisting: opts.upToExisting,
          syncedBlocks: 0,
        });

        p('Starting from: ', start);
        p('         to  : ', end);
        p('         opts: ', JSON.stringify(opts));

        self.getPrevNextBlock(start, end, opts, function(err) {
          if (err && err.message.match(/ECONNREFUSED/)) {
            setTimeout(function() {
              p('Retrying in %d secs', retry_secs);
              sync();
            },
            retry_secs * 1000);
          }
          else return next(err);
        });
      }

      if (err) {
        self.syncInfo = util._extend(self.syncInfo, {
          error: err.message
        });
        return next(err, 0);
      }
      else {
        sync();
      }
    });
  };

  // upto if we have genesis block?
  HistoricSync.prototype.smart_import = function(next) {
    var self = this;

    Block.findOne({
      hash: self.genesis
    },
    function(err, b) {

      if (err) return next(err);

      if (!b) {
        p('Could not find Genesis block. Running FULL SYNC');
      }
      else {
        p('Genesis block found. Syncing upto known blocks.');
      }

      var opts = {
        reverse: true,
        upToExisting: b ? true: false,
      };

      return self.import_history(opts, next);
    });
  };

  return HistoricSync;
}
module.defineClass(spec);
