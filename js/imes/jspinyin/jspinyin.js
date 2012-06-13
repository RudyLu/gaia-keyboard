/* -*- Mode: js; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

(function() {
var debugging = true;
var debug = function(str) {
  if (!debugging)
    return;

  if (window.dump) {
    window.dump('jspinyin: ' + str + '\n');
  }
  if (typeof console != 'undefined' && console.log) {
    console.log('jspinyin: ' + str);
    if (arguments.length > 1) {
      console.log.apply(this, arguments);
    }
  }
  if (typeof print == 'function') {
    print('jspinyin: ' + str + '\n');
  }
};

var assert = function(condition, msg) {
  if (!debugging)
    return;
  if (!condition) {
    throw msg;
  }
};

/* for non-Mozilla browsers */
if (!KeyEvent) {
  var KeyEvent = {
    DOM_VK_BACK_SPACE: 0x8,
    DOM_VK_RETURN: 0xd
  };
}

var StringUtils = {
  charDiff: function stringUtils_charDiff(ch1, ch2) {
    return ch1.charCodeAt(0) - ch2.charCodeAt(0);
  },

  /**
   * Format a string. Use {0}, {1} and {nth} to represent the 1st, 2nd
   * and (n+1)th arguments respectively.
   * For example:
   * var str= StringUtils.format('{0} has {1} bags', 'Ben', 4);
   * The result is 'Ben has 4 bags'.
   */
  format: function(src) {
      if (arguments.length == 0) return null;
      var args = Array.prototype.slice.call(arguments, 1);
      return src.replace(/\{(\d+)\}/g, function(m, i) {
        var arg = args[i];
        if (typeof arg == 'object') {
          arg = JSON.stringify(arg);
        }
        return arg;
      });
  }
};

/**
 * Max terms to match for incomplete or abbreviated syllables
 */
var MAX_TERMS_FOR_INCOMPLETE_SYLLABLES = 10;

var SyllableUtils = {
  /**
   * Converts a syllables array to a string that each syllable will be sperated
   * by '. For example, ['bei', 'jing'] will be converted to "bei'jing".
   */
  arrayToString: function syllableUtils_arrayToString(array) {
    return array.join("'");
  },

  /**
   * Converts a syllables string to an array.
   * For example, "bei'jing" will be converted to [bei'jing].
   */
  arrayFromString: function syllableUtils_arrayFromString(str) {
    return str.split("'");
  },

  /**
   * Converts a syllables string to its abbreviated form.
   * For example, "bei'jing" will be converted to "b'j"
   */
  stringToAbbreviated: function syllableUtils_stringToAbbreviated(str) {
    return str.replace(/([^'])[^']*/g, '$1');
  }
};

var Term = function term_constructor(phrase, freq) {
  this.phrase = phrase;
  this.freq = freq;
};

Term.prototype = {
  /*The actual string of the term, such as '北京'.*/
  phrase: '',
  /* The frequency of the term*/
  freq: 0
};

/**
 * Terms with same pronunciation.(同音词)
 */
var Homonyms = function homonyms_constructor(syllablesString, terms) {
  this.syllablesString = syllablesString;
  this.abbreviatedSyllablesString =
    SyllableUtils.stringToAbbreviated(syllablesString);

  // Clone a new array
  this.terms = terms.concat();
};

Homonyms.prototype = {
  // Full pinyin syllables(全拼), such as "bei'jing"
  syllablesString: '',
  // Abbreviated pinyin syllabels(简拼), such as "b'j" for "bei'jing"
  abbreviatedSyllablesString: '',
  // Terms array, such as [new Term('北京', 0.010), new Term('背景', 0.005)]
  terms: null
};

/**
 * An index class to speed up the search operation for ojbect array.
 * @param {Array} targetArray The array to be indexed.
 * @param {String} keyPath The key path for the index to use.
 */
var Index = function index_constructor(targetArray, keyPath) {
  this._keyMap = {};
  this._sortedKeys = [];
  for (var i = 0; i < targetArray.length; i++) {
    var key = targetArray[i][keyPath];
    if (!(key in this._keyMap)) {
      this._keyMap[key] = [];
      this._sortedKeys.push(key);
    }
    this._keyMap[key].push(i);
  }
  this._sortedKeys.sort(SearchUtility.compare);
};

Index.prototype = {
  // Map the key to the index of the storage array
  _keyMap: null,

  // Keys array in ascendingrt order.
  _sortedKeys: null,

  /**
   * Get array indices by given key.
   * @return {Array} An array of index.
   */
  get: function index_get(key) {
    var indices = [];
    if (key in this._keyMap) {
      indices = indices.concat(this._keyMap[key]);
    }
    return indices;
  },

  /**
   * Get array indices by given key range.
   * @param {String} lower The lower bound of the key range. If null, the range
   * has no lower bound.
   * @param {String} upper The upper bound of the key range. If null, the range
   * has no upper bound.
   * @param {Boolean} lowerOpen If false, the range includes the lower bound
   * value. If the range has no lower bound, it will be ignored.
   * @param {Boolean} upperOpen If false, the range includes the upper bound
   * value. If the range has no upper bound, it will be ignored.
   * @return {Array} An array of index.
   */
  getRange: function index_getRange(lower, upper, lowerOpen, upperOpen) {
    var indices = [];
    if (this._sortedKeys.length == 0) {
      return indices;
    }

    var pos = 0;

    // lower bound position
    var lowerPos = 0;
    // uppder bound position
    var upperPos = this._sortedKeys.length - 1;

    if (lower) {
      pos = this._binarySearch(lower, 0, upperPos);
      if (pos == Infinity) {
        return indices;
      }
      if (pos != -Infinity) {
        lowerPos = Math.ceil(pos);
      }
      if (lowerOpen && this._sortedKeys[lowerPos] == lower) {
        lowerPos++;
      }
    }

    if (upper) {
      pos = this._binarySearch(upper, lowerPos, upperPos);
      if (pos == -Infinity) {
        return indices;
      }
      if (pos != Infinity) {
        upperPos = Math.floor(pos);
      }
      if (upperOpen && this._sortedKeys[upperPos] == upper) {
        upperPos--;
      }
    }

    for (var i = lowerPos; i <= upperPos; i++) {
      var key = this._sortedKeys[i];
      indices = indices.concat(this._keyMap[key]);
    }
    return indices;
  },

  /**
   * Search the key position.
   * @param {String} key The key to search.
   * @param {Number} left The begin position of the array. It should be less
   * than the right parameter.
   * @param {Number} right The end position of the array.It should be greater
   * than the left parameter.
   * @return {Number} If success, returns the index of the key.
   * If the key is between two adjacent keys, returns the average index of the
   * two keys. If the key is out of bounds, returns Infinity or -Infinity.
   */
  _binarySearch: function index_binarySearch(key, left, right) {
    if (key < this._sortedKeys[left]) {
      return -Infinity;
    }
    if (key > this._sortedKeys[right]) {
      return Infinity;
    }

    while (right > left) {
      var mid = Math.floor((left + right) / 2);
      var midKey = this._sortedKeys[mid];
      if (midKey < key) {
        left = mid + 1;
      } else if (midKey > key) {
        right = mid - 1;
      } else {
        return mid;
      }
    }

    // left == right == mid
    var leftKey = this._sortedKeys[left];
    if (leftKey == key) {
      return left;
    } else if (leftKey < key) {
      return left + 0.5;
    } else {
      return left - 0.5;
    }
  }
};

var Task = function task_constructor(taskFunc, taskData) {
  this.func = taskFunc;
  this.data = taskData;
};

Task.prototype = {
  /**
   * Task function
   */
  func: null,
  /**
   * Task private data
   */
  data: null
};

var TaskQueue = function taskQueue_constructor(oncomplete) {
  this.oncomplete = oncomplete;
  this._queue = [];
  this.data = {};
};

TaskQueue.prototype = {
  /**
   * Callback Javascript function object that is called when the task queue is
   * empty. The definition of callback is function oncomplete(queueData).
   */
  oncomplete: null,

  /**
   * Data sharing with all tasks of the queue
   */
  data: null,

  /**
   * Task queue array.
   */
  _queue: null,

  /**
   * Add a new task to the tail of the queue.
   * @param {Function} taskFunc Task function object. The definition is function
   * taskFunc(taskQueue, taskData).
   * The taskQueue parameter is the task queue object itself, while the taskData
   * parameter is the data property
   * of the task queue object.
   * @param {Object} taskData The task's private data.
   */
  push: function taskQueue_push(taskFunc, taskData) {
    this._queue.push(new Task(taskFunc, taskData));
  },

  /**
   * Start running the task queue or process the next task.
   * It should be called when a task, including the last one, is finished.
   */
  processNext: function taskQueue_processNext() {
    if (this._queue.length > 0) {
      var task = this._queue.shift();
      if (typeof task.func == 'function') {
        task.func(this, task.data);
      } else {
        this.processNext();
      }
    } else {
      if (typeof this.oncomplete == 'function') {
        this.oncomplete(this.data);
      }
    }
  },

  /**
   * Get the number of remaining tasks.
   */
  getSize: function taskQueue_getSize() {
    return this._queue.length;
  }
};

/** Maximum limit of PinYin syllable length */
var SYLLALBLE_MAX_LENGTH = 6;

var SyllableType = {
  /**
   * Complete syllable, such as "yue", "bei".
   */
  COMPLETE: 0,
  /**
   * Abbreviated syllable that starts with a single consonant(声母),
   * such as "b", "j".
   */
  ABBREVIATED: 1,
  /**
   * An incomplete syllables is part of complete syllable. It is neither an
   * abbreviated syllable, nor a complete syllable, such as "be".
   */
  INCOMPLETE: 2,
  /**
   * Invalid syllale.
   */
  INVALID: 3
};

var Syllable = function syllable_constructor(str, type) {
  this.str = str;
  this.type = type;
};

Syllable.prototype = {
  /**
   * The syllable string, such as 'ai'
   */
  str: '',

  /**
   * The syllable type
   */
  type: SyllableType.COMPLETE
};

/**
 * Divides a string into Pinyin syllables
 */
var PinyinParser = function pinyinParser_constructor() {
  // Consonants(声母) list
  var consonants =
    'b p m f d t n l g k h j q x zh ch sh r z c s y w'.split(' ');

  this._consonantMap = {};
  for (var i in consonants) {
    var e = consonants[i];
    this._consonantMap[e] = e;
  }

  // Valid pinyin syllables list
  var syllables = [
    'a', 'o', 'e',

    'ai', 'ei', 'ao', 'ou', 'er', 'an', 'en', 'ang', 'eng',

    'ba', 'bai', 'ban', 'bang', 'bao', 'bei', 'ben', 'beng', 'bi', 'bian',
    'biao', 'bie', 'bin', 'bing', 'bo', 'bu',

    'pa', 'pai', 'pan', 'pang', 'pao', 'pei', 'pen', 'peng', 'pi', 'pian',
    'piao', 'pie', 'pin', 'ping', 'po', 'pou', 'pu',

    'ma', 'mai', 'man', 'mang', 'mao', 'me', 'mei', 'men', 'meng', 'mi', 'mian',
    'miao', 'mie', 'min', 'ming', 'miu', 'mo', 'mou', 'mu',

    'fa', 'fan', 'fang', 'fei', 'fen', 'feng', 'fo', 'fou', 'fu',

    'da', 'dai', 'dan', 'dang', 'dao', 'de', 'dei', 'deng', 'di', 'dian',
    'diao', 'die', 'ding', 'diu', 'dong', 'dou', 'du', 'duan', 'dui', 'dun',
    'duo',

    'ta', 'tai', 'tan', 'tang', 'tao', 'te', 'teng', 'ti', 'tian', 'tiao',
    'tie', 'ting', 'tong', 'tou', 'tu', 'tuan', 'tui', 'tun', 'tuo',

    'na', 'nai', 'nan', 'nang', 'nao', 'ne', 'nei', 'nen', 'neng', 'ni', 'nian',
    'niang', 'niao', 'nie', 'nin', 'ning', 'niu', 'nong', 'nou', 'nu', 'nv',
    'nuan', 'nve', 'nuo',

    'la', 'lai', 'lan', 'lang', 'lao', 'le', 'lei', 'leng', 'li', 'lia',
    'lian', 'liang', 'liao', 'lie', 'lin', 'ling', 'liu', 'long', 'lou',
    'lu', 'lv', 'luan', 'lve', 'lun', 'luo',

    'ga', 'gai', 'gan', 'gang', 'gao', 'ge', 'gei', 'gen', 'geng', 'gong',
    'gou', 'gu', 'gua', 'guai', 'guan', 'guang', 'gui', 'gun', 'guo',

    'ka', 'kai', 'kan', 'kang', 'kao', 'ke', 'ken', 'keng', 'kong', 'kou',
    'ku', 'kua', 'kuai', 'kuan', 'kuang', 'kui', 'kun', 'kuo',

    'ha', 'hai', 'han', 'hang', 'hao', 'he', 'hei', 'hen', 'heng', 'hong',
    'hou', 'hu', 'hua', 'huai', 'huan', 'huang', 'hui', 'hun', 'huo',

    'ji', 'jia', 'jian', 'jiang', 'jiao', 'jie', 'jin', 'jing', 'jiong',
    'jiu', 'ju', 'juan', 'jue', 'jun',

    'qi', 'qia', 'qian', 'qiang', 'qiao', 'qie', 'qin', 'qing', 'qiong', 'qiu',
    'qu', 'quan', 'que', 'qun',

    'xi', 'xia', 'xian', 'xiang', 'xiao', 'xie', 'xin', 'xing', 'xiong', 'xiu',
    'xu', 'xuan', 'xue', 'xun',

    'zhi', 'zha', 'zhai', 'zhan', 'zhang', 'zhao', 'zhe', 'zhei', 'zhen',
    'zheng',
    'zhong', 'zhou', 'zhu', 'zhua', 'zhuai', 'zhuan', 'zhuang', 'zhui', 'zhun',
    'zhuo',

    'chi', 'cha', 'chai', 'chan', 'chang', 'chao', 'che', 'chen', 'cheng',
    'chong',
    'chou', 'chu', 'chua', 'chuai', 'chuan', 'chuang', 'chui', 'chun', 'chuo',

    'shi', 'sha', 'shai', 'shan', 'shang', 'shao', 'she', 'shei', 'shen',
    'sheng',
    'shou', 'shu', 'shua', 'shuai', 'shuan', 'shuang', 'shui', 'shun', 'shuo',

    'ri', 'ran', 'rang', 'rao', 're', 'ren', 'reng', 'rong', 'rou', 'ru',
    'ruan', 'rui', 'run', 'ruo',

    'zi', 'za', 'zai', 'zan', 'zang', 'zao', 'ze', 'zei', 'zen', 'zeng',
    'zong', 'zou', 'zu', 'zuan', 'zui', 'zun', 'zuo',

    'ci', 'ca', 'cai', 'can', 'cang', 'cao', 'ce', 'cen', 'ceng', 'cong',
    'cou', 'cu', 'cuan', 'cui', 'cun', 'cuo',

    'si', 'sa', 'sai', 'san', 'sang', 'sao', 'se', 'sen', 'seng', 'song',
    'sou', 'su', 'suan', 'sui', 'sun', 'suo',

    'ya', 'yan', 'yang', 'yao', 'ye', 'yi', 'yin', 'ying', 'yong', 'you',
    'yu', 'yuan', 'yue', 'yun',

    'wa', 'wai', 'wan', 'wang', 'wei', 'wen', 'weng', 'wo', 'wu'
    ];

  this._syllableArray = [];
  for (var i in syllables) {
    var e = syllables[i];
    this._syllableArray.push({syllable: e});
  }

  this._syllableIndex = new Index(this._syllableArray, 'syllable');
};

PinyinParser.prototype = {
  /**
   * Consonant(声母) lookup map that maps a lowercase consonant to itself.
   * _consonantMap
   */
  _consonantMap: null,

  /**
   * Syllable array, such as [{syllable: 'a'}, {syllable: 'ai'}]
   */
  _syllableArray: null,

  /**
   * syllableMap index to speed up search operation
   */
  _syllableIndex: null,

  /**
   * Divides a string into Pinyin syllables.
   *
   * There may exists more than one ways to divide the string. Each way of the
   * division is a segment.
   *
   * For example, "fangan" could be divided into "FangAn"(方案) or "FanGan"(反感)
   * ; "xian" could be divided into "Xian"(先) or "XiAn"(西安); "dier" could be
   * divided into "DiEr"(第二) or "DieR".
   *
   * @param {String} input The string to be divided. The string should not be
   * empty.
   * @return {Array} An array of segments.
   */
  parse: function pinyinParser_parse(input) {
    var results = [];

    // Trims the leading and trailing "'".
    input = input.replace(/^'+|'+$/g, '');

    if (input == '') {
      return results;
    }

    var end = input.length;
    for (; end > 0; end--) {
      var sub = input.substring(0, end);
      results = this._parseInternal(sub);
      if (results.length > 0) {
        break;
      }
    }

    if (end != input.length) {
      // The input contains invalid syllable.
      var invalidSyllable = input.substring(end);
      results = this._appendsSubSegments(results,
        [[new Syllable(invalidSyllable, SyllableType.INVALID)]]);
    }

    return results;
  },

  /**
   * Divides a string into valid syllables.
   *
   * There may exists more than one ways to divide the string. Each way of the
   * division is a segment.
   *
   * For example, "fangan" could be divided into "FangAn"(方案) or "FanGan"(反感)
   * ; "xian" could be divided into "Xian"(先) or "XiAn"(西安); "dier" could be
   * divided into "DiEr"(第二) or "DieR".
   *
   * @param {String} input The string to be divided. The string should not be
   * empty.
   * @return {Array} An array of segments.
   * If the input string contains any invalid syllables, returns empty array.
   */
  _parseInternal: function pinyinParser_parseInternal(input) {
    var results = [];

    // Trims the leading and trailing "'".
    input = input.replace(/^'+|'+$/g, '');

    if (input == '') {
      return results;
    }

    var end = Math.min(input.length, SYLLALBLE_MAX_LENGTH);
    for (; end > 0; end--) {
      var key = input.substring(0, end);
      var type = this._getSyllableType(key);
      if (type != SyllableType.INVALID) {
        var segments = [];
        var subSegments = [];
        if (end < input.length) {
          subSegments = this._parseInternal(input.substring(end));
          if (subSegments.length == 0) {
            continue;
          }
        }
        segments.push([new Syllable(key, type)]);
        segments = this._appendsSubSegments(segments, subSegments);
        results = results.concat(segments);
      }
    }

    // Sort the segments array. The segment with fewer incomplete syllables and
    // shorter length comes first.
    var self = this;
    results.sort(function sortSegements(a, b) {
      var ai = self._getIncompleteness(a);
      var bi = self._getIncompleteness(b);
      if (ai != bi) {
        return ai - bi;
      } else {
        return a.length - b.length;
      }
    });
    return results;
  },

  /**
   * Check if the input string is a syllable
   */
  _getSyllableType: function pinyinParser_getSyllableType(str) {
    if (str in this._consonantMap) {
      return SyllableType.ABBREVIATED;
    }

    var indices = this._syllableIndex.get(str);
    if (indices.length > 0) {
      return SyllableType.COMPLETE;
    }

    var upperBound = str.substr(0, str.length - 1) +
      String.fromCharCode(str.substr(str.length - 1).charCodeAt(0) + 1);
    indices = this._syllableIndex.getRange(str, upperBound, true, true);
    if (indices.length > 0) {
      return SyllableType.INCOMPLETE;
    }

    return SyllableType.INVALID;
  },

  /**
   * Get cartesian product of two segments arrays.
   * Cartesian product A X B:
   * A X B = {(a, b) | a is member of A and b is member of B}.
   */
  _appendsSubSegments: function pinyinParser_appendsSubSegments(
      segments, subSegments) {
    if (segments.length == 0) {
      return subSegments;
    }
    if (subSegments.length == 0) {
      return segments;
    }

    var result = [];
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      for (var j = 0; j < subSegments.length; j++) {
        result.push(segment.concat(subSegments[j]));
      }
    }
    return result;
  },

  /**
   * Get the incompleteness of syllables.
   *
   * Syllables containing incomplete and abbreviated syllable is of higher
   * incompleteness value than those not.
   *
   * @param {Array} segement The segement array containing the syllables to be
   * evaluated.
   * @return {Nunmber} The number of incompleteness. A higher value means more
   * incomplete or abbreviated syllables.
   */
  _getIncompleteness: function pinyinParser_getIncompleteness(segment) {
    var value = 0;
    for (var i in segment) {
      var type = segment[i].type;
      if (type == SyllableType.ABBREVIATED) {
        value += 2;
      } else if (type == SyllableType.INCOMPLETE) {
        value += 1;
      } else if (type == SyllableType.INVALID) {
        value += 3 * segment[i].str.length;
      }
    }
    return value;
  }
};

var IMEngineBase = function engineBase_constructor() {
  this._glue = {};
};

IMEngineBase.prototype = {
  /**
   * Glue ojbect between the IMEngieBase and the IMEManager.
   */
  _glue: {
    /**
     * The source code path of the IMEngine
     * @type String
     */
    path: '',

    /**
     * Sends candidates to the IMEManager
     */
    sendCandidates: function(candidates) {},

    /**
     * Sends pending symbols to the IMEManager.
     */
    sendPendingSymbols: function(symbols) {},

    /**
     * Passes the clicked key to IMEManager for default action.
     * @param {number} keyCode The key code of an integer.
     */
    sendKey: function(keyCode) {},

    /**
     * Sends the input string to the IMEManager.
     * @param {String} str The input string.
     */
    sendString: function(str) {},

    /**
     * Change the keyboad
     * @param {String} keyboard The name of the keyboard.
     */
    alterKeyboard: function(keyboard) {}
  },

  /**
   * Initialization.
   * @param {Glue} glue Glue object of the IMManager.
   */
  init: function engineBase_init(glue) {
    this._glue = glue;
  },
  /**
   * Destruction.
   */
  uninit: function engineBase_uninit() {
  },

  /**
   * Notifies when a keyboard key is clicked.
   * @param {number} keyCode The key code of an integer number.
   */
  click: function engineBase_click(keyCode) {
  },

  /**
   * Notifies when pending symbols need be cleared
   */
  empty: function engineBase_empty() {
  },

  /**
   * Notifies when a candidate is selected.
   * @param {String} text The text of the candidate.
   * @param {Object} data User data of the candidate.
   */
  select: function engineBase_select(text, data) {
    this._glue.sendString(text);
  },

  /**
   * Notifies when the IM is shown
   */
  show: function engineBase_show(inputType) {
  }
};

var IMEngine = function engine_constructor(splitter) {
  IMEngineBase.call(this);

  this._splitter = splitter;
  this._db = {
    simplified: null,
    traditional: null
  };
  this._selectedSyllables = [];
  this._keypressQueue = [];
};

IMEngine.prototype = {
  __proto__: new IMEngineBase(),

  _splitter: null,

  // Enable IndexedDB
  _enableIndexedDB: true,

  // Tell the algorithm what's the longest term
  // it should attempt to match
  _kDBTermMaxLength: 8,

  // Buffer limit will force output the longest matching terms
  // if the length of the syllables buffer is reached.
  _kBufferLenLimit: 30,

  // Auto-suggest generates candidates that follows a selection
  // taibei -> 台北, then suggest 市, 縣, 市長, 市立 ...
  _autoSuggestCandidates: true,

  // Whether to input traditional Chinese
  _inputTraditionalChinese: false,

  // Input method database
  _db: null,

  // The last selected text and syllables used to generate suggestions.
  _selectedText: '',
  _selectedSyllables: null,

  _pendingSymbols: '',
  _firstCandidate: '',
  _keypressQueue: null,
  _isWorking: false,

  // Current keyboard
  _keyboard: 'zh-Hans-Pinyin',

  _getCurrentDatabaseName: function engine_getCurrentDatabaseName() {
    return this._inputTraditionalChinese ? 'traditional' : 'simplified';
  },

  _initDB: function engine_initDB(name, readyCallback) {
    var dbSettings = {
      enableIndexedDB: this._enableIndexedDB
    };

    if (readyCallback) {
      dbSettings.ready = readyCallback;
    }

    var jsonUrl = this._glue.path +
      (name == 'traditional' ? '/db-tr.json' : '/db.json');
    this._db[name] = new IMEngineDatabase(name, jsonUrl);
    this._db[name].init(dbSettings);
  },

  _sendPendingSymbols: function engine_sendPendingSymbols() {
    debug('SendPendingSymbol: ' + this._pendingSymbols);
    this._glue.sendPendingSymbols(this._pendingSymbols);
  },

  _sendCandidates: function engine_sendCandidates(candidates) {
    this._firstCandidate = (candidates[0]) ? candidates[0][0] : '';
    this._glue.sendCandidates(candidates);
  },

  _start: function engine_start() {
    if (this._isWorking)
      return;
    this._isWorking = true;
    debug('Start keyQueue loop.');
    this._next();
  },

  _next: function engine_next() {
    debug('Processing keypress');

    var name = this._getCurrentDatabaseName();

    if (!this._db[name]) {
      debug('DB not initialized, defer processing.');
      this._initDB(name, this._next.bind(this));
      return;
    }

    if (!this._keypressQueue.length) {
      debug('keyQueue emptied.');
      this._isWorking = false;
      return;
    }

    var code = this._keypressQueue.shift();

    if (code == 0) {
      // This is a select function operation.
      this._sendPendingSymbols();
      this._updateCandidateList(this._next.bind(this));
      return;
    }

    debug('key code: ' + code);

    // Backspace - delete last input symbol if exists
    if (code === KeyEvent.DOM_VK_BACK_SPACE) {
      debug('Backspace key');
      if (!this._pendingSymbols) {
        if (this._firstCandidate) {
          debug('Remove candidates.');

          // prevent updateCandidateList from making the same suggestions
          this._selectedText = '';
          this._selectedSyllables = [];

          this._updateCandidateList(this._next.bind(this));
          return;
        }
        // pass the key to IMEManager for default action
        debug('Default action.');
        this._glue.sendKey(code);
        this._next();
        return;
      }

      this._pendingSymbols = this._pendingSymbols.substring(0,
        this._pendingSymbols.length - 1);

      this._sendPendingSymbols();
      this._updateCandidateList(this._next.bind(this));
      return;
    }

    // Select the first candidate if needed.
    if (code === KeyEvent.DOM_VK_RETURN ||
        !this._isSymbol(code) ||
        this._pendingSymbols.length >= this._kBufferLenLimit) {
      debug('Nono-bopomofo key is pressed or the input is too long.');
      var sendKey = true;
      if (this._firstCandidate) {
        if (this._pendingSymbols) {
          // candidate list exists; output the first candidate
          debug('Sending first candidate.');
          this._glue.sendString(this._firstCandidate);
          this.empty();
          // no return here
          if (code === KeyEvent.DOM_VK_RETURN) {
            sendKey = false;
          }
        }
        this._sendCandidates([]);
      }

      //pass the key to IMEManager for default action
      debug('Default action.');
      if (sendKey) {
        this._glue.sendKey(code);
      }
      this._next();
      return;
    }

    var symbol = String.fromCharCode(code);

    debug('Processing symbol: ' + symbol);

    // add symbol to pendingSymbols
    this._appendNewSymbol(code);

    this._sendPendingSymbols();
    this._updateCandidateList(this._next.bind(this));
  },

  _isSymbol: function engine_isSymbol(code) {

    // '
    if (code == 39) {
      return true;
    }

    // a-z
    if (code >= 97 && code <= 122) {
      return true;
    }

    return false;
  },

  _appendNewSymbol: function engine_appendNewSymbol(code) {
    var symbol = String.fromCharCode(code);
    this._pendingSymbols += symbol;
  },

  _updateCandidateList: function engine_updateCandidateList(callback) {
    debug('Update Candidate List.');
    var self = this;
    var name = this._getCurrentDatabaseName();
    if (!this._pendingSymbols) {
      if (this._autoSuggestCandidates &&
          this._selectedSyllables.length) {
        debug('Buffer is empty; ' +
          'make suggestions based on select term.');
        var candidates = [];
        var text = this._selectedText;
        var selectedSyllables = this._selectedSyllables;
        this._db[name].getSuggestions(selectedSyllables, text,
          function(suggestions) {
            suggestions.forEach(
              function suggestions_forEach(suggestion) {
                candidates.push(
                  [suggestion.phrase.substr(text.length),
                   SyllableUtils.arrayToString(selectedSyllables)]);
              }
            );
            self._sendCandidates(candidates);
            callback();
          }
        );
        return;
      }
      debug('Buffer is empty; send empty candidate list.');
      this._sendCandidates([]);
      callback();
      return;
    }

    this._selectedText = '';
    this._selectedSyllables = [];

    var candidates = [];
    var segments = this._splitter.parse(this._pendingSymbols);
    var syllablesForQuery = [];
    if (segments.length > 0) {
      var segment = segments[0];
      for (var i = 0; i < segment.length; i++) {
        syllablesForQuery.push(segment[i].str);
      }
    }

    var syllablesStr = SyllableUtils.arrayToString(syllablesForQuery);

    if (syllablesForQuery.length == 0) {
      candidates.push([this._pendingSymbols, syllablesStr]);
      this._sendCandidates(candidates);
      callback();
      return;
    }

    debug('Get term candidates for the entire buffer.');
    this._db[name].getTerms(syllablesForQuery, function lookupCallback(terms) {
      terms.forEach(function readTerm(term) {
        candidates.push([term.phrase, syllablesStr]);
      });

      if (syllablesForQuery.length === 1) {
        debug('Only one syllable; skip other lookups.');

        if (!candidates.length) {
          // candidates unavailable; output symbols
          candidates.push([self._pendingSymbols, syllablesStr]);
        }

        self._sendCandidates(candidates);
        callback();
        return;
      }

      debug('Lookup for sentences that make up from the entire buffer');
      var syllables = syllablesForQuery;
      self._db[name].getSentence(syllables,
        function getSentenceCallback(sentence) {
        // look for candidate that is already in the list
        var exists = candidates.some(function sentenceExists(candidate) {
          return (candidate[0] === sentence);
        });

        if (!exists) {
          candidates.push([sentence, syllablesStr]);
        }

        // The remaining candidates doesn't match the entire buffer
        // these candidates helps user find the exact character/term
        // s/he wants
        // The remaining unmatched syllables will go through lookup
        // over and over until the buffer is emptied.

        var i = Math.min(self._kDBTermMaxLength, syllablesForQuery.length - 1);

        var findTerms = function lookupFindTerms() {
          debug('Lookup for terms that matches first ' + i + ' syllables.');

          var syllables = syllablesForQuery.slice(0, i);
          var syllablesStr = SyllableUtils.arrayToString(syllables);
          self._db[name].getTerms(syllables, function lookupCallback(terms) {
            terms.forEach(function readTerm(term) {
              candidates.push([term.phrase, syllablesStr]);
            });

            if (i === 1 && !terms.length) {
              debug('The first syllable does not make up a word,' +
                ' output the symbol.');
              candidates.push(
                [syllables.join(''), syllablesStr]);
            }

            if (!--i) {
              debug('Done Looking.');
              self._sendCandidates(candidates);
              callback();
              return;
            }

            findTerms();
            return;
          });
        };

        findTerms();
      });
    });
  },

  _alterKeyboard: function engine_changeKeyboard(keyboard) {
    this._keyboard = keyboard;
    this.empty();
    this._glue.alterKeyboard(keyboard);
  },

  /**
   * Override
   */
  init: function engine_init(glue) {
    IMEngineBase.prototype.init.call(this, glue);
    debug('init.');
    var keyboard = this._inputTraditionalChinese ?
      'zh-Hans-Pinyin-tr' : 'zh-Hans-Pinyin';
    this._alterKeyboard(keyboard);
  },

  /**
   * Override
   */
  uninit: function engine_uninit() {
    IMEngineBase.prototype.uninit.call(this);
    debug('Uninit.');
    this._splitter = null;
    for (var name in ['simplified', 'traditional']) {
      if (this._db[name]) {
        this._db[name].uninit();
        this._db[name] = null;
      }
    }
    this.empty();
  },

  /**
   *Override
   */
  click: function engine_click(keyCode) {
    IMEngineBase.prototype.click.call(this, keyCode);

    switch (keyCode) {
      case -10:
        // Switch to traditional Chinese input mode.
        this._inputTraditionalChinese = true;
        this._alterKeyboard('zh-Hans-Pinyin-tr');
        break;
      case -11:
        // Switch to simplified Chinese input mode.
        this._inputTraditionalChinese = false;
        this._alterKeyboard('zh-Hans-Pinyin');
        break;
      case -12:
        // Switch to number keyboard.
        this._alterKeyboard('zh-Hans-Pinyin-number');
        break;
      case -13:
        // Switch to symbol0 keyboard.
        this._alterKeyboard('zh-Hans-Pinyin-symbol0');
        break;
      case -14:
        // Switch to symbol1 keyboard.
        this._alterKeyboard('zh-Hans-Pinyin-symbol1');
        break;
      case -15:
        // Switch to symbol2 keyboard.
        this._alterKeyboard('zh-Hans-Pinyin-symbol2');
        break;
      case -20:
        // Switch back to the basic keyboard.
        var keyboard = this._inputTraditionalChinese ?
          'zh-Hans-Pinyin-tr' : 'zh-Hans-Pinyin';
        this._alterKeyboard(keyboard);
        break;
      default:
        this._keypressQueue.push(keyCode);
        break;
    }
    this._start();
  },

  /**
   * Override
   */
  select: function engine_select(text, data) {
    IMEngineBase.prototype.select.call(this, text, data);

    var syllablesToRemove = SyllableUtils.arrayFromString(data);
    if (this._pendingSymbols != '') {
      for (var i = 0; i < syllablesToRemove.length; i++) {
        var syllable = syllablesToRemove[i];
        // Trims the leading "'".
        this._pendingSymbols = this._pendingSymbols.replace(/^'+/g, '');
        this._pendingSymbols = this._pendingSymbols.substring(syllable.length);
      }
      this._optimizedSyllables = [];
    }

    this._selectedText = text;
    this._selectedSyllables = syllablesToRemove;
    this._keypressQueue.push(0);
    this._start();
  },

  /**
   * Override
   */
  empty: function engine_empty() {
    IMEngineBase.prototype.empty.call(this);
    debug('empty.');
    var name = this._getCurrentDatabaseName();
    this._pendingSymbols = '';
    this._selectedText = '';
    this._selectedSyllables = [];
    this._sendPendingSymbols();
    this._isWorking = false;
    if (!this._db[name])
      this._initDB(name);
  },

  /**
   * Override
   */
  show: function engine_show(inputType) {
    IMEngineBase.prototype.show.call(this, inputType);
    debug('Show. Input type: ' + inputType);
    var keyboard = this._inputTraditionalChinese ?
      'zh-Hans-Pinyin-tr' : 'zh-Hans-Pinyin';
    if (inputType == '' || inputType == 'text' || inputType == 'textarea') {
      keyboard = this._keyboard;
    }

    this._glue.alterKeyboard(keyboard);
  }
};

var DatabaseStorageBase = function storagebase_constructor() {
};

/**
 * DatabaseStorageBase status code enumeration.
 */
DatabaseStorageBase.StatusCode = {
  /* The storage isn't initilized.*/
  UNINITIALIZED: 0,
  /* The storage is busy.*/
  BUSY: 1,
  /* The storage has been successfully initilized and is ready to use.*/
  READY: 2,
  /* The storage is failed to initilized and cannot be used.*/
  ERROR: 3
};

DatabaseStorageBase.prototype = {
  _status: DatabaseStorageBase.StatusCode.UNINITIALIZED,

  /**
   * Get the status code of the storage.
   * @return {DatabaseStorageBase.StatusCode} The status code.
   */
  getStatus: function storagebase_getStatus() {
    return this._status;
  },

  /**
   * Whether the database is ready to use.
   */
  isReady: function storagebase_isReady() {
    return this._status == DatabaseStorageBase.StatusCode.READY;
  },

  /**
   * Initialization.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback(statusCode). The statusCode parameter is of type
   * DatabaseStorageBase.StatusCode that stores the status of the storage
   * after Initialization.
   */
  init: function storagebase_init(callback) {
  },

  /**
   * Destruction.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished.
   * The definition of callback is function callback().
   */
  uninit: function storagebase_uninit(callback) {
  },


  /**
   * Whether the storage is empty.
   * @return {Boolean} true if the storage is empty; otherwise false.
   */
  isEmpty: function storagebase_isEmpty() {
  },

  /**
   * Get all terms.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback(homonymsArray). The homonymsArray parameter is an array
   * of Homonyms objects.
   */
  getAllTerms: function storagebase_getAllTerms(callback) {
  },

  /**
   * Set all the terms of the storage.
   * @param {Array} homonymsArray The array of Homonyms objects containing all
   * the terms.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback().
   */
  setAllTerms: function storagebase_setAllTerms(homonymsArray, callback) {
  },

  /**
   * Get iterm with given syllables string.
   * @param {String} syllablesStr The syllables string of the matched terms.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback(homonymsArray). The homonymsArray parameter is an array
   * of Homonyms objects.
   */
  getTermsBySyllables: function storagebase_getTermsBySyllables(
    syllablesStr, callback) {
  },

  /**
   * Get iterms with given syllables string prefix.
   * @param {String} prefix The prefix of the syllables string .
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback(homonymsArray). The homonymsArray parameter is an array
   * of Homonyms objects.
   */
  getTermsBySyllablesPrefix: function storagebase_getTermsBySyllablesPrefix(
    prefix, callback) {
  },

  /**
   * Get iterm with given incomplete or abbreviated syllables string. The given
   * syllables could be partially incomplete or abbreviated.
   * @param {String} incomplete The partially incomplete or abbreviated
   * syllables string of the matched terms.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback(homonymsArray). The homonymsArray parameter is an array
   * of Homonyms objects.
   */
  getTermsByIncompleteSyllables: function
    storagebase_getTermsByIncompleteSyllables(incomplete, callback) {
  },

  /**
   * Add a term to the storage.
   * @param {String} syllablesStr The syllables string of the term.
   * @param {Term} term The Term object of the term.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback().
   */
  addTerm: function storagebase_addTerm(syllablesStr, term, callback) {
  },

  /**
   * Remove a term from the storage.
   * @param {String} syllablesStr The syllables string of the term.
   * @param {Term} term The Term object of the term.
   * @param {Function} callback Javascript function object that is called when
   * the operation is finished. The definition of callback is
   * function callback().
   */
  removeTerm: function storagebase_removeTerm(syllablesStr, term, callback) {
  }
};

var JsonStorage = function jsonStorage_construtor(jsonUrl) {
  this._jsonUrl = jsonUrl;
  this._dataArray = [];
};

JsonStorage.prototype = {
  // Inherits DatabaseStorageBase
  __proto__: new DatabaseStorageBase(),

  _dataArray: null,

  // The JSON file url.
  _jsonUrl: null,

  _syllablesIndex: null,

  _abrreviatedIndex: null,

  /**
   * Override
   */
  init: function jsonStorage_init(callback) {
    var self = this;
    var doCallback = function init_doCallback() {
      if (callback) {
        callback(self._status);
      }
    }
    // Check if we could initilize.
    if (this._status != DatabaseStorageBase.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = DatabaseStorageBase.StatusCode.BUSY;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', this._jsonUrl, true);
    try {
      xhr.responseType = 'json';
    } catch (e) { }
    xhr.overrideMimeType('application/json; charset=utf-8');
    xhr.onreadystatechange = function xhrReadystatechange(ev) {
      if (xhr.readyState !== 4) {
        self._status = DatabaseStorageBase.StatusCode.ERROR;
        return;
      }

      var response;
      if (xhr.responseType == 'json') {
        try {
          // clone everything under response because it's readonly.
          self._dataArray = xhr.response.slice();
        } catch (e) {
        }
      }

      if (typeof self._dataArray !== 'object') {
        self._status = DatabaseStorageBase.StatusCode.ERROR;
        doCallback();
        return;
      }

      xhr = null;
      setTimeout(performBuildIndices, 100);
    };

    var performBuildIndices = function init_performBuildIndices() {
      self._buildIndices();
      self._status = DatabaseStorageBase.StatusCode.READY;
      doCallback();
    };

    xhr.send(null);
  },

  /**
   * Override
   */
  uninit: function jsonStorage_uninit(callback) {
    var doCallback = function uninit_doCallback() {
      if (callback) {
        callback();
      }
    }

    // Check if we could uninitilize the storage
    if (this._status == DatabaseStorageBase.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Perform destruction operation
    this._dataArray = [];

    this._status = DatabaseStorageBase.StatusCode.UNINITIALIZED;
    doCallback();
  },

  /**
   * Override
   */
  isEmpty: function jsonStorage_isEmpty() {
    return this._dataArray.length == 0;
  },

  /**
   * Override
   */
  getAllTerms: function jsonStorage_getAllTerms(callback) {
    var self = this;
    var homonymsArray = [];
    var doCallback = function getAllTerms_doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var perform = function getAllTerms_perform() {
      // Query all terms
      homonymsArray = homonymsArray.concat(self._dataArray);
      doCallback();
    }

    setTimeout(perform, 0);
  },

  /**
   * Override
   */
  getTermsBySyllables: function jsonStorage_getTermsBySyllables(syllablesStr,
    callback) {
    var self = this;
    var homonymsArray = [];
    var doCallback = function getTermsBySyllables_doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var perform = function getTermsBySyllables_perform() {
      var indices = self._syllablesIndex.get(syllablesStr);
      for (var i = 0; i < indices.length; i++) {
        var index = indices[i];
        homonymsArray.push(self._dataArray[index]);
      }
      doCallback();
    }

    setTimeout(perform, 0);
  },

  /**
   * Override
   */
  getTermsBySyllablesPrefix: function
    jsonStorage_getTermsBySyllablesPrefix(prefix, callback) {
    var self = this;
    var homonymsArray = [];
    function doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var perform = function() {
      var upperBound = prefix.substr(0, prefix.length - 1) +
        String.fromCharCode(prefix.substr(prefix.length - 1).charCodeAt(0) + 1);
      var indices =
        self._syllablesIndex.getRange(prefix, upperBound, false, false);
      for (var i = 0; i < indices.length; i++) {
        var index = indices[i];
        homonymsArray.push(self._dataArray[index]);
      }
      doCallback();
    }

    setTimeout(perform, 0);
  },

  /**
   * Override
   */
  getTermsByIncompleteSyllables: function
    jsonStorage_getTermsByIncompleteSyllables(incomplete, callback) {
    var self = this;
    var homonymsArray = [];
    var doCallback = function getTermsByIncompleteSyllables_doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var matchRegEx = new RegExp(
       '^' + incomplete.replace(/([^']+)/g, "$1[^']*"));
    var fullyAbbreviated = SyllableUtils.stringToAbbreviated(incomplete);

    var perform = function getTermsByIncompleteSyllables_perform() {
      var indices = self._abrreviatedIndex.get(fullyAbbreviated);
      for (var i = 0; i < indices.length; i++) {
        var index = indices[i];
        var homonyms = self._dataArray[index];
        var syllablesStr = homonyms.syllablesString;
        if (matchRegEx.exec(syllablesStr)) {
          homonymsArray.push(homonyms);
        }
      }
      doCallback();
    }

    setTimeout(perform, 0);
  },

  _buildIndices: function jsonStorage_buildIndices() {
    this._syllablesIndex = new Index(this._dataArray, 'syllablesString');
    this._abrreviatedIndex = new Index(this._dataArray,
      'abbreviatedSyllablesString');
  }
};


/**
 * Interfaces of indexedDB
 */
var IndexedDB = {
  indexedDB: window.indexedDB || window.webkitIndexedDB ||
    window.mozIndexedDB || window.msIndexedDB,

  IDBDatabase: window.IDBDatabase || window.webkitIDBDatabase ||
    window.msIDBDatabase,

  IDBIndex: window.IDBIndex || window.webkitIDBIndex || window.msIDBIndex,

  /**
   * Check if the indexedDB is available on this platform
   */
  isReady: function indexedDB_isReady() {
    if (!this.indexedDB || // No IndexedDB API implementation
        this.IDBDatabase.prototype.setVersion || // old version of IndexedDB API
        window.location.protocol === 'file:') {  // bug 643318
      debug('IndexedDB is not available on this platform.');
      return false;
    }
    return true;
  }
};

var IndexedDBStorage = function indexedDBStorage_constructor(dbName) {
  this._dbName = dbName;
};

IndexedDBStorage.kDBVersion = 1.0;

IndexedDBStorage.prototype = {
  // Inherits DatabaseStorageBase
  __proto__: new DatabaseStorageBase(),

  // Database name
  _dbName: null,

  // IDBDatabase interface
  _IDBDatabase: null,

  _count: 0,

  /**
   * Override
   */
  init: function indexedDBStorage_init(callback) {
    var self = this;
    function doCallback() {
      if (callback) {
        callback(self._status);
      }
    }

    // Check if we could initilize.
    if (!IndexedDB.isReady() ||
        this._status != DatabaseStorageBase.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = DatabaseStorageBase.StatusCode.BUSY;

    // Open the database
    var req = IndexedDB.indexedDB.open(this._dbName,
      IndexedDBStorage.kDBVersion);
    req.onerror = function dbopenError(ev) {
      debug('Encounter error while opening IndexedDB.');
      self._status = DatabaseStorageBase.StatusCode.ERROR;
      doCallback();
    };

    req.onupgradeneeded = function dbopenUpgradeneeded(ev) {
      debug('IndexedDB upgradeneeded.');
      self._IDBDatabase = ev.target.result;

      // delete the old ObjectStore if present
      if (self._IDBDatabase.objectStoreNames.length !== 0) {
        self._IDBDatabase.deleteObjectStore('homonyms');
      }

      // create ObjectStore
      var store = self._IDBDatabase.createObjectStore('homonyms',
        { keyPath: 'syllablesString' });
      store.createIndex(
        'abbreviatedSyllablesString', 'abbreviatedSyllablesString',
        { unique: false });

      // no callback() here
      // onupgradeneeded will follow by onsuccess event
    };

    req.onsuccess = function dbopenSuccess(ev) {
      debug('IndexedDB opened.');
      self._IDBDatabase = ev.target.result;

      self._status = DatabaseStorageBase.StatusCode.READY;
      self._count = 0;

      // Check the integrity of the storage
      self.getTermsBySyllables('_last_entry_',
        function getLastEntryCallback(homonymsArray) {
        if (homonymsArray.length == 0) {
          debug('IndexedDB is broken.');
          // Could not find the '_last_entry_' element. The storage is broken
          // and ignore all the data.
          doCallback();
          return;
        }

        var transaction =
          self._IDBDatabase.transaction(['homonyms'], 'readonly');
        // Get the count
        var reqCount = transaction.objectStore('homonyms').count();

        reqCount.onsuccess = function(ev) {
          debug('IndexedDB count: ' + ev.target.result);
          self._count = ev.target.result - 1;
          self._status = DatabaseStorageBase.StatusCode.READY;
          doCallback();
        };

        reqCount.onerror = function(ev) {
          self._status = DatabaseStorageBase.StatusCode.ERROR;
          doCallback();
        };
      });
    };
  },

  /**
   * Override
   */
  uninit: function indexedDBStorage_uninit(callback) {
    function doCallback() {
      if (callback) {
        callback();
      }
    }

    // Check if we could uninitilize the storage
    if (this._status == DatabaseStorageBase.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Perform destruction operation
    if (this._IDBDatabase) {
      this._IDBDatabase.close();
    }

    this._status = DatabaseStorageBase.StatusCode.UNINITIALIZED;
    doCallback();
  },

  /**
   * Override
   */
  isEmpty: function indexedDBStorage_isEmpty() {
    return this._count == 0;
  },

  /**
   * Override
   */
  getAllTerms: function indexedDBStorage_getAllTerms(callback) {
    var homonymsArray = [];
    function doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    // Query all terms
    var store = this._IDBDatabase.transaction(['homonyms'], 'readonly')
      .objectStore('homonyms');
    var req = store.openCursor();

    req.onerror = function(ev) {
      debug('Database read error.');
      doCallback();
    };
    req.onsuccess = function(ev) {
      var cursor = ev.target.result;
      if (cursor) {
        var homonyms = cursor.value;
        if (homonyms.syllablesString != '_last_entry_') {
          homonymsArray.push(homonyms);
        }
        cursor.continue();
      } else {
        doCallback();
      }
    };
  },

  setAllTerms: function indexedDBStorage_setAllTerms(homonymsArray, callback) {
    var self = this;
    function doCallback() {
      self._status = DatabaseStorageBase.StatusCode.READY;
      if (callback) {
        callback();
      }
    }

    var n = homonymsArray.length;

    // Check if the storage is ready.
    if (!this.isReady() || n == 0) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = DatabaseStorageBase.StatusCode.BUSY;

    // Use task queue to add the terms by batch to prevent blocking the main
    // thread.
    var taskQueue = new TaskQueue(
      function taskQueueOnCompleteCallback(queueData) {
      self._count = n;
      doCallback();
    });

    var processNextWithDelay = function setAllTerms_rocessNextWithDelay() {
      setTimeout(function nextTask() {
        taskQueue.processNext();
      }, 0);
    };

    // Clear all the terms before adding
    var clearAll = function setAllTerms_clearAll(taskQueue, taskData) {
      var transaction =
        self._IDBDatabase.transaction(['homonyms'], 'readwrite');
      var store = transaction.objectStore('homonyms');
      var req = store.clear();
      req.onsuccess = function(ev) {
        debug('IndexedDB cleared.');
        processNextWithDelay();
      };

      req.onerror = function(ev) {
        debug('Failed to clear IndexedDB.');
        self._status = DatabaseStorageBase.StatusCode.ERROR;
        doCallback();
      };

    };

    // Add a batch of terms
    var addChunk = function setAllTerms_addChunk(taskQueue, taskData) {
      var transaction =
        self._IDBDatabase.transaction(['homonyms'], 'readwrite');
      var store = transaction.objectStore('homonyms');
      transaction.onerror = function(ev) {
        debug('Database write error.');
        doCallback();
      };

      transaction.oncomplete = function() {
        processNextWithDelay();
      };

      var begin = taskData.begin;
      var end = taskData.end;
      for (var i = begin; i <= end; i++) {
        var homonyms = homonymsArray[i];
        store.put(homonyms);
      }

      // Add a special element to indicate that all the items are saved.
      if (end == n - 1) {
        store.put(new Homonyms('_last_entry_', []));
      }
    };

    taskQueue.push(clearAll, null);

    for (var begin = 0; begin < n; begin += 2000) {
      var end = Math.min(begin + 1999, n - 1);
      taskQueue.push(addChunk, {begin: begin, end: end});
    }

    processNextWithDelay();
  },

  /**
   * Override
   */
  getTermsBySyllables: function
    indexedDBStorage_getTermsBySyllables(syllablesStr, callback) {
    var homonymsArray = [];
    function doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var store = this._IDBDatabase.transaction(['homonyms'], 'readonly')
      .objectStore('homonyms');
    var req = store.get(syllablesStr);

    req.onerror = function(ev) {
      debug('Database read error.');
      doCallback();
    };

    req.onsuccess = function(ev) {
      var homonyms = ev.target.result;
      if (homonyms) {
        homonymsArray.push(homonyms);
      }
      doCallback();
    };
  },

  /**
   * Override
   */
  getTermsBySyllablesPrefix: function
    indexedDBStorage_getTermsBySyllablesPrefix(prefix, callback) {
    var homonymsArray = [];
    function doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var upperBound = prefix.substr(0, prefix.length - 1) +
      String.fromCharCode(prefix.substr(prefix.length - 1).charCodeAt(0) + 1);

    var store = this._IDBDatabase.transaction(['homonyms'], 'readonly')
      .objectStore('homonyms');
    var req =
      store.openCursor(IDBKeyRange.bound(prefix, upperBound, true, true));

    req.onerror = function(ev) {
      debug('Database read error.');
      doCallback();
    };
    req.onsuccess = function(ev) {
      var cursor = ev.target.result;
      if (cursor) {
        var homonyms = cursor.value;
        homonymsArray.push(homonyms);
        cursor.continue();
      } else {
        doCallback();
      }
    };
  },

  /**
   * Override
   */
  getTermsByIncompleteSyllables: function
    indexedDBStorage_getTermsByIncompleteSyllables(incomplete, callback) {
    var homonymsArray = [];
    function doCallback() {
      if (callback) {
        callback(homonymsArray);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var matchRegEx = new RegExp(
       '^' + incomplete.replace(/([^']+)/g, "$1[^']*"));

    var fullyAbbreviated = SyllableUtils.stringToAbbreviated(incomplete);

    var store = this._IDBDatabase.transaction(['homonyms'], 'readonly')
      .objectStore('homonyms');
    var req = store.index('abbreviatedSyllablesString').openCursor(
      IDBKeyRange.only(fullyAbbreviated));

    req.onerror = function(ev) {
      debug('Database read error.');
      doCallback();
    };
    req.onsuccess = function(ev) {
      var cursor = ev.target.result;
      if (cursor) {
        var homonyms = cursor.value;
        if (matchRegEx.exec(homonyms.syllablesString)) {
          homonymsArray.push(homonyms);
        }
        cursor.continue();
      } else {
        doCallback();
      }
    };
  }
};

var IMEngineDatabase = function imedb(dbName, jsonUrl) {
  var settings;

  /**
   * Dictionary words' total frequency.
   */
  var kDictTotalFreq = 1.0e8;

  var jsonStorage = new JsonStorage(jsonUrl);
  var indexedDBStorage = new IndexedDBStorage(dbName);

  var iDBCache = {};
  var cacheTimer;
  var kCacheTimeout = 10000;

  var self = this;

  /* ==== init functions ==== */

  var populateDBFromJSON = function imedb_populateDBFromJSON(callback) {
    jsonStorage.getAllTerms(function getAllTermsCallback(homonymsArray) {
      indexedDBStorage.setAllTerms(homonymsArray, callback);
    });
  };

  /* ==== helper functions ==== */

  /*
  * Data from IndexedDB gets to kept in iDBCache for kCacheTimeout seconds
  */
  var cacheSetTimeout = function imedb_cacheSetTimeout() {
    debug('Set iDBCache timeout.');
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function imedb_cacheTimeout() {
      debug('Empty iDBCache.');
      iDBCache = {};
    }, kCacheTimeout);
  };

  /* ==== init ==== */

  this.init = function imedb_init(options) {
    settings = options;

    var ready = function() {
      debug('Ready.');
      if (settings.ready)
        settings.ready();
    };

    if (!settings.enableIndexedDB) {
      debug('IndexedDB disabled; Downloading JSON ...');
      jsonStorage.init(ready);
      return;
    }

    debug('Probing IndexedDB ...');
    indexedDBStorage.init(function indexedDBStorageInitCallback() {
      if (!indexedDBStorage.isReady()) {
        debug('IndexedDB not available; Downloading JSON ...');
        jsonStorage.init(ready);
        return;
      }
      ready();
      if (indexedDBStorage.isEmpty()) {
        jsonStorage.init(function jsonStorageInitCallback() {
          if (!jsonStorage.isReady()) {
            debug('JSON failed to download.');
            return;
          }

          debug(
            'JSON loaded,' +
            'IME is ready to use while inserting data into db ...'
          );
          populateDBFromJSON(function populateDBFromJSONCallback() {
            if (!indexedDBStorage.isEmpty()) {
              debug('IndexedDB ready and switched to indexedDB backend.');
              jsonStorage.uninit();
            } else {
              debug('Failed to populate IndexedDB from JSON.');
            }
          });
        });
      }
    });
  };

  /* ==== uninit ==== */

  this.uninit = function imedb_uninit() {
    indexedDBStorage.uninit();
    jsonStorage.uninit();
  };

  var getUsableStorage = function imedb_getUsableStorage() {
    if (settings.enableIndexedDB &&
        indexedDBStorage.isReady() &&
        !indexedDBStorage.isEmpty()) {
      return indexedDBStorage;
    } else if (jsonStorage.isReady() && !jsonStorage.isEmpty()) {
      return jsonStorage;
    } else {
      return null;
    }
  };

  /* ==== db lookup functions ==== */

  this.getSuggestions =
    function imedb_getSuggestions(syllables, textStr, callback) {
    var storage = getUsableStorage();
    if (!storage) {
      debug('Database not ready.');
      callback([]);
      return;
    }

    var syllablesStr = SyllableUtils.arrayToString(syllables);
    var result = [];
    var matchTerm = function getSuggestions_matchTerm(term) {
      if (term.phrase.substr(0, textStr.length) !== textStr)
        return;
      if (term.phrase == textStr)
        return;
      result.push(term);
    };
    var processResult = function getSuggestions_processResult(r) {
      r.sort(
        function getSuggestions_sort(a, b) {
          return (b.freq - a.freq);
        }
      );
      var result = [];
      var t = [];
      r.forEach(function terms_foreach(term) {
        if (t.indexOf(term.phrase) !== -1) return;
        t.push(term.phrase);
        result.push(term);
      });
      return result;
    };
    var result = [];

    debug('Get suggestion for ' + textStr + '.');

    if (typeof iDBCache['SUGGESTION:' + textStr] !== 'undefined') {
      debug('Found in iDBCache.');
      cacheSetTimeout();
      callback(iDBCache['SUGGESTION:' + textStr]);
      return;
    }

    storage.getTermsBySyllablesPrefix(syllablesStr,
      function getTermsBySyllablesPrefix_callback(homonymsArray) {
      for (var i = 0; i < homonymsArray.length; i++) {
        var homonyms = homonymsArray[i];
        homonyms.terms.forEach(matchTerm);
      }
      if (result.length) {
        result = processResult(result);
      }
      cacheSetTimeout();
      iDBCache['SUGGESTION:' + textStr] = result;
      callback(result);
    });
  },

  this.getTerms = function imedb_getTerms(syllables, callback) {
    var storage = getUsableStorage();
    if (!storage) {
      debug('Database not ready.');
      callback([]);
      return;
    }

    var syllablesStr = SyllableUtils.arrayToString(syllables);
    debug('Get terms for ' + syllablesStr + '.');

    var processResult = function processResult(r, limit) {
      r.sort(
        function rtrt_result(a, b) {
          return (b.freq - a.freq);
        }
      );
      var result = [];
      var t = [];
      r.forEach(function(term) {
        if (t.indexOf(term.phrase) !== -1) return;
        t.push(term.phrase);
        result.push(term);
      });
      if (limit > 0) {
        result = result.slice(0, limit);
      }
      return result;
    };

    if (typeof iDBCache[syllablesStr] !== 'undefined') {
      debug('Found in iDBCache.');
      cacheSetTimeout();
      callback(iDBCache[syllablesStr]);
      return;
    }

    storage.getTermsBySyllables(syllablesStr, function(homonymsArray)
     {
      var result = [];
      for (var i = 0; i < homonymsArray.length; i++) {
        var homonyms = homonymsArray[i];
        result = result.concat(homonyms.terms);
      }
      if (result.length) {
        result = processResult(result, -1);
        cacheSetTimeout();
        iDBCache[syllablesStr] = result;
        callback(result);
      } else {
        storage.getTermsByIncompleteSyllables(syllablesStr,
          function(homonymsArray) {
            var result = [];
            for (var i = 0; i < homonymsArray.length; i++) {
              var homonyms = homonymsArray[i];
              result = result.concat(homonyms.terms);
            }
            if (result.length) {
              result =
                processResult(result, MAX_TERMS_FOR_INCOMPLETE_SYLLABLES);
            } else {
              result = [];
            }
            cacheSetTimeout();
            iDBCache[syllablesStr] = result;
            callback(result);
          }
        );
      }
    });

  };

  this.getTermWithHighestScore =
  function imedb_getTermWithHighestScore(syllables, callback) {
    self.getTerms(syllables, function getTermsCallback(terms) {
      if (terms == null) {
        callback(null);
        return;
      }
      callback(terms[0]);
    });
  }

  this.getSentence = function imedb_getSentence(syllables, callback) {
    var self = this;
    var doCallback = function getSentence_doCallback(sentence) {
      if (callback) {
        callback(sentence);
      }
    };

    var n = syllables.length;

    if (n == 0) {
      callback('');
    }

    var taskQueue = new TaskQueue(
      function taskQueueOnCompleteCallback(queueData) {
      var sentences = queueData.sentences;
      var sentence = sentences[sentences.length - 1];
      doCallback(sentence);
    });

    taskQueue.data = {
      sentences: ['', ''],
      probabilities: [1, 0],
      sentenceLength: 1,
      lastPhraseLength: 1
    };

    var getSentenceSubTask = function getSentence_subTask(taskQueue, taskData) {
      var queueData = taskQueue.data;
      var sentenceLength = queueData.sentenceLength;
      var lastPhraseLength = queueData.lastPhraseLength;
      var sentences = queueData.sentences;
      var probabilities = queueData.probabilities;
      if (probabilities.length < sentenceLength + 1) {
        probabilities.push(-1);
      }
      if (sentences.length < sentenceLength + 1) {
        sentences.push('');
      }
      var maxProb = probabilities[sentenceLength];
      var s = syllables.slice(sentenceLength -
        lastPhraseLength, sentenceLength);
      self.getTermWithHighestScore(s,
        function getTermWithHighestScoreCallback(term) {
          if (term == null) {
            var syllable = s.join('');
            term = {phrase: syllable, freq: 0};
          }
          var prob = probabilities[sentenceLength -
              lastPhraseLength] * term.freq / kDictTotalFreq;
          if (prob > probabilities[sentenceLength]) {
            probabilities[sentenceLength] = prob;
            sentences[sentenceLength] =
              sentences[sentenceLength - lastPhraseLength] + term.phrase;
          }

          // process next step
          if (lastPhraseLength < sentenceLength) {
            queueData.lastPhraseLength++;
          } else {
            queueData.lastPhraseLength = 1;
            if (sentenceLength < n) {
              queueData.sentenceLength++;
            } else {
              taskQueue.processNext();
              return;
            }
          }
          taskQueue.push(getSentenceSubTask, null);
          taskQueue.processNext();
        }
      );
    };

    taskQueue.push(getSentenceSubTask, null);
    taskQueue.processNext();
  };
};

var PinyinDecoderService = {
  // Private instance of the MatrixSearch
  _matrixSearch: null,

  /**
   * Open the decoder engine via the system and user dictionary file names.
   *
   * @param {String} sysDict The file name of the system dictionary.
   * @param {String} usrDict The file name of the user dictionary.
   * @return {Boolean} true if open the decode engine sucessfully.
   */
  open: function decoderService_open(sysDict, usrDict) {
    this._matrixSearch = new MatrixSearch();
    return this._matrixSearch.init(sysDict, usrDict);
  },

  /**
   * Close the decode engine.
   */
  close: function decoderService_close() {
    if (this._matrixSearch != null) {
      this._matrixSearch.uninit();
      this._matrixSearch = null;
    }
  },

  /**
   * Flush cached data to persistent memory. Because at runtime, in order to
   * achieve best performance, some data is only store in memory.
   */
  flush_cache: function decoderService_flush_cache() {
    if (this._matrixSearch != null) {
      this._matrixSearch.flush_cache();
    }
  },

  /**
   * Use a spelling string(Pinyin string) to search. The engine will try to do
   * an incremental search based on its previous search result, so if the new
   * string has the same prefix with the previous one stored in the decoder,
   * the decoder will only continue the search from the end of the prefix.
   * If the caller needs to do a brand new search, please call
   * im_reset_search() first.
   *
   * @param {String} spsStr The spelling string buffer to decode.
   * @return {Integer} The number of candidates.
   */
  search: function decoderService_search(spsStr) {
    if (this._matrixSearch == null) {
      return 0;
    }
    this._matrixSearch.search(spsStr);
    return this._matrixSearch.getCandidateNum();
  },

  /**
   * Make a delete operation in the current search result, and make research if
   * necessary.
   *
   * @param {Integer} pos The posistion of char in spelling string to delete,
   * or the position of spelling id in result string to delete.
   * @param {Boolean} isPosInspl_id Indicate whether the pos parameter is the
   * position in the spelling string, or the position in the result spelling id
   * string.
   * @param {Boolean} clearFixed If true, the fixed spellings will be cleared.
   * @return {Integer} The number of candidates.
   */
  delSearch: function decoderService_delSearch(pos, isPosInspl_id, clearFixed) {
    if (this._matrixSearch == null) {
      return 0;
    }
    this._matrixSearch.delSearch(pos, isPosInspl_id, clearFixed);
    return this._matrixSearch.getCandidateNum();
  },

  /**
   * Reset the previous search result.
   */
  resetSearch: function decoderService_resetSearch() {
    if (this._matrixSearch == null) {
      return;
    }
    this._matrixSearch.resetSearch();
  },

  /**
   * Get the spelling string kept by the decoder.
   *
   * @return {String} The spelling string kept by the decoder.
   */
  getSpsStr: function decoderService_getSpsStr() {
    if (this._matrixSearch == null) {
      return '';
    }
    return this._matrixSearch.getSpsStr();
  },

  /**
   * Get a candidate(or choice) string.
   *
   * @param {Integer} candId The id to get a candidate. Started from 0.
   * Usually, id 0 is a sentence-level candidate.
   * @return {String } The candidate string if succeeds, otherwise null.
   */
  getCandidate: function decoderService_getCandidate(candId) {
    if (this._matrixSearch == null) {
      return '';
    }
    return this._matrixSearch.getCandidate(candId);
  },

  /**
   * Get the segmentation information(the starting positions) of the spelling
   * string.
   *
   * @return {Array} An array contains the starting position of all the
   * spellings.
   */
  getSplStartPos: function decoderService_getSplStartPos() {
    if (this._matrixSearch == null) {
      return 0;
    }
    return this._matrixSearch.getSplStartPos();
  },

  /**
   * Choose a candidate and make it fixed. If the candidate does not match
   * the end of all spelling ids, new candidates will be provided from the
   * first unfixed position. If the candidate matches the end of the all
   * spelling ids, there will be only one new candidates, or the whole fixed
   * sentence.
   *
   * @param {Integer} candId The id of candidate to select and make it fixed.
   * @return {Integer} The number of candidates. If after the selection, the
   * whole result string has been fixed, there will be only one candidate.
   */
  choose: function decoderService_choose(candId) {
    if (this._matrixSearch == null) {
      return;
    }
    this._matrixSearch.choose(candId);
  },

  /**
   * Get the number of fixed spelling ids, or Chinese characters.
   *
   * @return {Integer} The number of fixed spelling ids, of Chinese characters.
   */
  getFixedLen: function decoderService_getFixedLen() {
    if (this._matrixSearch == null) {
      return 0;
    }
    return this._matrixSearch.getFixedLen();
  },

  /**
   * Get prediction candiates based on the given fixed Chinese string as the
   * history.
   *
   * @param {String} history The history string to do the prediction.
   * @return {String[]} The prediction result list of an string array.
   */
  getPredicts: function decoderService_getPredicts(history) {
    if (this._matrixSearch == null) {
      return [];
    }
    return this._matrixSearch.getPredicts(history);
  }
};

var FileSystemService = {
  Type: {
    IndexedDB: 0,
    SpiderMonkey: 1
  },

  /**
   * Initialization.
   * @param {function(): void} callback
   * Javascript function object that is called
   * when the operation is finished.
   */
  init: function fileSystemService_init(callback) {
    var self = this;
    function doCallback() {
      if (callback) {
        callback();
      }
    }

    var taskQueue = new TaskQueue(
        function taskQueueOnCompleteCallback(queueData) {
      doCallback();
    });

    var processNextWithDelay =
        function fileSystemService_rocessNextWithDelay() {
      if (typeof setTimeout != 'undefined') {
        setTimeout(function nextTask() {
          taskQueue.processNext();
        }, 0);
      } else {
        taskQueue.processNext();
      }
    };

    taskQueue.push(function initIdb(taskQueue, taskData) {
      var store = new IndexedDBFileSystemStorage();
      FileSystemService._storages[0] = store;
      store.init(function idbCallback(statusCode) {
        processNextWithDelay();
      });
    });

    taskQueue.push(function initIdb(taskQueue, taskData) {
      var store = new SpiderMonkeyFileSystemStorage();
      FileSystemService._storages[1] = store;
      store.init(function idbCallback(statusCode) {
        processNextWithDelay();
      });
    });

    taskQueue.processNext();
  },

  /**
   * Destruction.
   */
  uninit: function fileSystemService_uninit() {
    if (FileSystemService._idb) {
      FileSystemService._idb.uninit();
      FileSystemService._idb = null;
    }
    if (FileSystemService._sm) {
      FileSystemService._sm.uninit();
      FileSystemService._sm = null;
    }
  },
  /**
   * @param {FileSystemService.Type} type The type code of the file system.
   */
  isFileSystemReady: function fileSystemService_isFileSystemReady(type) {
    if (type < 0 || type >= FileSystemService.PROTOCOLS.length) {
      return false;
    }
    if (FileSystemService._storages[type] &&
        FileSystemService._storages[type].isReady()) {
      return true;
    }
    return false;
  },

  /**
   * Read the entire contents of a file.
   * @param {string} uri The file path.
   * @param {function(string): void} callback The function object that is
   *    called when the operation is finished. The definition of callback is
   *    function callback(str). The str parameter is the content of the file,
   *    which will be an empty string if the file is empty or does not exist.
   */
  read: function fileSystemService_read(uri, callback) {
    var ret = FileSystemService._parse(uri);
    FileSystemService._storages[ret.type].read(ret.path, callback);
  },

  /**
   * Save a file.
   * @param {string} uri The file uri.
   * @param {string} str The file content.
   * @param {function(boolean): void} callback The function object that is
   *    called when the operation is finished. The boolean parameter indicates
   *    whether the file is saved successfully.
   */
  write: function fileSystemService_write(uri, str, callback) {
    var ret = FileSystemService._parse(uri);
    FileSystemService._storages[ret.type].write(ret.path, str, callback);
  },

  /**
   * Delete a file.
   * @param {string} uri The file uri.
   * @param {function(boolean): void} callback The function object that is
   *    called when the operation is finished. The boolean parameter indicates
   *    whether the file is deleted successfully.
   */
  del: function fileSystemService_del(uri, callback) {
    var ret = FileSystemService._parse(uri);
    FileSystemService._storages[ret.type].del(ret.path, callback);
  },

  _storages: [null, null],

  PROTOCOLS: ['idb', 'sm'],

  /**
   * Parse the file uri to get the file system type code and file path.
   * For example, if the uri is 'idb://rawdict.txt', the type code
   * Type.IndexedDB and the path is 'rawdict.txt'.
   * @return {type: FileSystemService.Type, path: string} Returns the type and
   * path. If the type cannot be determined, the default type Type.IndexedDB is
   * returned.
   */
  _parse: function fileSystemService_parse(uri) {
    var type = FileSystemService.Type.IndexedDB;
    var path = uri.trim();
    var n = FileSystemService.PROTOCOLS.length;
    for (var i = 0; i < n; i++) {
      var pro = FileSystemService.PROTOCOLS[i];
      if (uri.indexOf(pro) != -1) {
        type = i;
        path = path.substring(pro.length + 3);
      }
    }
    return {type: type, path: path};
  }
};

var File = function file_constructor(name, str) {
  this.name = name;
  this.content = str;
};

File.prototype = {
  name: '',
  content: ''
};

var FileSystemStorage = function fileSystemStorage_constructor() {
};

/**
 * FileSystemStorage status code enumeration.
 */
FileSystemStorage.StatusCode = {
  /* The storage isn't initilized.*/
  UNINITIALIZED: 0,
  /* The storage is busy.*/
  BUSY: 1,
  /* The storage has been successfully initilized and is ready to use.*/
  READY: 2,
  /* The storage is failed to initilized and cannot be used.*/
  ERROR: 3
};

FileSystemStorage.prototype = {
  /**
   * @type FileSystemStorage.StatusCode
   */
  _status: FileSystemStorage.StatusCode.UNINITIALIZED,

  /**
   * Initialization.
   * @param {function(FileSystemStorage.StatusCode): void} callback
   * Javascript function object that is called
   * when the operation is finished. The definition of callback is
   * function callback(statusCode). The statusCode parameter is of type
   * DatabaseStorageBase.StatusCode that stores the status of the storage
   * after Initialization.
   */
  init: function fileSystemStorage_init(callback) {},

  /**
   * Destruction.
   */
  uninit: function fileSystemStorage_uninit() {},

  /**
   * Whether the database is ready to use.
   */
  isReady: function storagebase_isReady() {
    return this._status == FileSystemStorage.StatusCode.READY;
  },

  /**
   * Read the entire contents of a file.
   * @param {string} name The file name.
   * @param {function(string): void} callback The function object that is
   *    called when the operation is finished. The definition of callback is
   *    function callback(str). The str parameter is the content of the file,
   *    which will be an empty string if the file is empty or does not exist.
   */
  read: function fileSystemStorage_read(name, callback) {},

  /**
   * Save a file.
   * @param {string} name The file name.
   * @param {string} str The file content.
   * @param {function(boolean): void} callback The function object that is
   *    called when the operation is finished. The boolean parameter indicates
   *    whether the file is saved successfully.
   */
  write: function fileSystemStorage_write(name, str, callback) {},

  /**
   * Delete a file.
   * @param {string} name The file name.
   * @param {function(boolean): void} callback The function object that is
   *    called when the operation is finished. The boolean parameter indicates
   *    whether the file is deleted successfully.
   */
  del: function fileSystemStorage_del(name, callback) {}
};

/**
 * Simulate file system with indexedDB
 * @constructor
 */
var IndexedDBFileSystemStorage = function idbFileSystemStorage_constructor() {
  this._dbName = IndexedDBFileSystemStorage.DB_NAME;
  this._dbVersion = IndexedDBFileSystemStorage.DB_VERSION;
  this._dbStoreName = IndexedDBFileSystemStorage.STORE_NAME;
};

IndexedDBFileSystemStorage.DB_VERSION = 1.0;
IndexedDBFileSystemStorage.DB_NAME = 'fileSystem';
IndexedDBFileSystemStorage.STORE_NAME = 'files';

IndexedDBFileSystemStorage.prototype = {
  // Inherits FileSystemStorage
  __proto__: new FileSystemStorage(),

  // IDBDatabase interface
  _IDBDatabase: null,

  _dbName: '',

  _dbVersion: 0,

  _dbStoreName: '',

  /**
   * @override
   */
  init: function idbFileSystemStorage_init(callback) {
    var self = this;
    function doCallback() {
      if (callback) {
        callback(self._status);
      }
    }

    // Check if we could initilize.
    if (!IndexedDB.isReady() ||
        this._status != FileSystemStorage.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = FileSystemStorage.StatusCode.BUSY;

    // Open the database
    var req = IndexedDB.indexedDB.open(this._dbName, this._dbVersion);
    req.onerror = function dbopenError(ev) {
      debug('Encounter error while opening IndexedDB: ' + this._dbName);
      self._status = FileSystemStorage.StatusCode.ERROR;
      doCallback();
    };

    req.onupgradeneeded = function dbopenUpgradeneeded(ev) {
      debug('IndexedDB upgradeneeded.');
      self._IDBDatabase = ev.target.result;

      // delete the old ObjectStore if present
      if (self._IDBDatabase.objectStoreNames.length !== 0) {
        self._IDBDatabase.deleteObjectStore(this._dbStoreName);
      }

      // create ObjectStore
      var store = self._IDBDatabase.createObjectStore(this._dbStoreName,
                                                      { keyPath: 'name' });

      // no callback() here
      // onupgradeneeded will follow by onsuccess event
    };

    req.onsuccess = function dbopenSuccess(ev) {
      debug('IndexedDB opened.');
      self._IDBDatabase = ev.target.result;
      self._status = FileSystemStorage.StatusCode.READY;
      doCallback();
    };
  },

  /**
   * @override
   */
  uninit: function idbFileSystemStorage_uninit() {
    // Check if we need uninitilize the storage
    if (this._status == FileSystemStorage.StatusCode.UNINITIALIZED) {
      return;
    }

    // Perform destruction operation
    if (this._IDBDatabase) {
      this._IDBDatabase.close();
    }

    this._status = FileSystemStorage.StatusCode.UNINITIALIZED;
  },

  /**
   * @override
   */
  read: function idbFileSystemStorage_read(name, callback) {
    var content = '';
    function doCallback() {
      if (callback) {
        callback(content);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    var store = this._IDBDatabase.transaction([this._dbStoreName], 'readonly')
      .objectStore(this._dbStoreName);
    var req = store.get(name);

    req.onerror = function(ev) {
      debug('Database read error.');
      doCallback();
    };

    req.onsuccess = function(ev) {
      var file = ev.target.result;
      if (file) {
        content = file.content;
      }
      doCallback();
    };
  },

  /**
   * @override
   */
  write: function idbFileSystemStorage_write(name, str, callback) {
    var self = this;
    var isOk = false;
    function doCallback() {
      self._status = FileSystemStorage.StatusCode.READY;
      if (callback) {
        callback(isOk);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = FileSystemStorage.StatusCode.BUSY;

    var transaction =
      self._IDBDatabase.transaction([this._dbStoreName], 'readwrite');
    var store = transaction.objectStore(this._dbStoreName);
    transaction.onerror = function(ev) {
      debug('Database write error.');
      doCallback();
    };

    transaction.oncomplete = function() {
      isOk = true;
      doCallback();
    };

    store.put(new File(name, str));
  },

  /**
   * @override
   */
  del: function idbFileSystemStorage_del(name, callback) {
    var self = this;
    var isOk = false;
    function doCallback() {
      self._status = FileSystemStorage.StatusCode.READY;
      if (callback) {
        callback(isOk);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = FileSystemStorage.StatusCode.BUSY;

    var transaction =
      self._IDBDatabase.transaction([this._dbStoreName], 'readwrite');
    var store = transaction.objectStore(this._dbStoreName);
    transaction.onerror = function(ev) {
      debug('Database write error.');
      doCallback();
    };

    transaction.oncomplete = function() {
      isOk = true;
      doCallback();
    };

    store.delete(name);
  }
};

/**
 * Implement file system storage with SpiderMonkey file api.
 * @param {string} dir The base directory of the file system.
 */
var SpiderMonkeyFileSystemStorage =
    function spiderMonkeyFileSystemStorage_constructor(dir) {
  this._baseDir = dir;
};

SpiderMonkeyFileSystemStorage.prototype = {
  // Inherits FileSystemStorage
  __proto__: new FileSystemStorage(),

  _baseDir: '',

  /**
   * @override
   */
  init: function spiderMonkeyFileSystemStorage_init(callback) {
    debug('SpiderMonkeyFileSystemStorage init');
    var self = this;
    function doCallback() {
      if (callback) {
        callback(self._status);
      }
    }

    // Check if we could initilize.
    if (this._status != FileSystemStorage.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Set the status to busy.
    this._status = FileSystemStorage.StatusCode.BUSY;

    // Perform initialization operation
    if (typeof read == 'function') {
      self._status = FileSystemStorage.StatusCode.READY;
    } else {
      self._status = FileSystemStorage.StatusCode.ERROR;
    }

    doCallback();
  },

  /**
   * @override
   */
  uninit: function spiderMonkeyFileSystemStorage_uninit(callback) {
    function doCallback() {
      if (callback) {
        callback();
      }
    }

    // Check if we could uninitilize the storage
    if (this._status == FileSystemStorage.StatusCode.UNINITIALIZED) {
      doCallback();
      return;
    }

    // Perform destruction operation
    this._status = FileSystemStorage.StatusCode.UNINITIALIZED;
    doCallback();
  },

  /**
   * @override
   */
  read: function spiderMonkeyFileSystemStorage_read(name, callback) {
    debug('SpiderMonkeyFileSystemStorage read file: ' + name);
    var content = '';
    function doCallback() {
      if (callback) {
        callback(content);
      }
    }

    // Check if the storage is ready.
    if (!this.isReady()) {
      doCallback();
      return;
    }

    try {
      content = read(name);
    } catch (ex) {
      debug(ex);
    }

    doCallback();
  }
};

var DictDef = {
  // The max length of a lemma.
  kMaxLemmaSize: 8,

  // The max length of a Pinyin (spelling).
  kMaxPinyinSize: 6,

  // The number of half spelling ids. For Chinese Pinyin, there 30 half ids.
  // See SpellingTrie.h for details.
  kHalfSpellingIdNum: 29,

  // The maximum number of full spellings. For Chinese Pinyin, there are only
  // about 410 spellings.
  // If change this value is bigger(needs more bits), please also update
  // other structures like SpellingNode, to make sure than a spelling id can be
  // stored.
  // -1 is because that 0 is never used.
  kMaxSpellingNum: 512 - 29 - 1,

  kMaxSearchSteps: 40,

  // One character predicts its following characters.
  kMaxPredictSize: 8 - 1,

  // Actually, a Id occupies 3 bytes in storage.
  kLemmaIdSize: 3,
  kLemmaIdComposing: 0xffffff,

  // Number of items with highest score are kept for prediction purpose.
  kTopScoreLemmaNum: 10,

  kMaxPredictNumByGt3: 1,
  kMaxPredictNumBy3: 2,
  kMaxPredictNumBy2: 2,

  // The last lemma id (included) for the system dictionary. The system
  // dictionary's ids always start from 1.
  kSysDictIdEnd: 500000,

  // The first lemma id for the user dictionary.
  kUserDictIdStart: 500001,

  // The last lemma id (included) for the user dictionary.
  kUserDictIdEnd: 600000
};

DictDef.SpellingId = function spellingId_constructor(half_splid, full_splid) {
  this.half_splid = half_splid;
  this.full_splid = full_splid;
};

DictDef.SpellingId.prototype = {
  half_splid: 0,
  full_splid: 0
};

/**
 * We use different node types for different layers
 * Statistical data of the building result for a testing dictionary:
 *                              root,   level 0,   level 1,   level 2,   level 3
 * max son num of one node:     406        280         41          2          -
 * max homo num of one node:      0         90         23          2          2
 * total node num of a layer:     1        406      31766      13516        993
 * total homo num of a layer:     9       5674      44609      12667        995
 *
 * The node number for root and level 0 won't be larger than 500
 * According to the information above, two kinds of nodes can be used; one for
 * root and level 0, the other for these layers deeper than 0.
 *
 * LE = less and equal,
 * A node occupies 16 bytes. so, totallly less than 16 * 500 = 8K
 */
DictDef.LmaNodeLE0 = function lmaNodeLE0_constructor() {
};

DictDef.LmaNodeLE0.prototype = {
  son_1st_off: 0,
  homo_idx_buf_off: 0,
  pl_idx: 0,
  num_of_son: 0,
  num_of_homo: 0
};

/**
 * GE = great and equal
 */
DictDef.LmaNodeGE1 = function lmaNodeGE1_constructor() {
};

DictDef.LmaNodeGE1.prototype = {
  son_1st_off_l: 0,        // Low bits of the son_1st_off
  homo_idx_buf_off_l: 0,   // Low bits of the homo_idx_buf_off_1
  spl_idx: 0,
  num_of_son: 0,            // number of son nodes
  num_of_homo: 0,           // number of homo words
  son_1st_off_h: 0,         // high bits of the son_1st_off
  homo_idx_buf_off_h: 0    // high bits of the homo_idx_buf_off
};

DictDef.SingleCharItem = function singleCharItem_constructor() {
  this.splid = new DictDef.SpellingId();
};

DictDef.SingleCharItem.prototype = {
  freq: 0.0,
  hz: '',
  /**
   * @type DictDef.SpellingId
   */
  splid: null
};

DictDef.LemmaEntry = function lemmaEntry_constructor() {
  this.hanzi_scis_ids = [];
  this.spl_idx_arr = [];
  this.pinyin_str = [];
};

DictDef.LemmaEntry.prototype = {
  idx_by_py: 0,
  idx_by_hz: 0,
  hanzi_str: '',

  // The SingleCharItem id for each Hanzi.
  hanzi_scis_ids: null,

  spl_idx_arr: null,
  /**
   * @type Array.<string>
   */
  pinyin_str: null,
  hz_str_len: 0, // TODO remove this field and use hanzi_str.length instead
  freq: 0.0
};

var SearchUtility = {
  /**
   * Compare two item.
   * @param {number | string | Array} a The first item to be compare.
   * @param {number | string | Array} b The second item to be compare.
   * @return {number} -1: a < b; 0: a = b; 1: a > b.
   */
  compare: function searchUtility_compare(a, b) {
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
    return 0;
  },

  is_system_lemma: function searchUtility_is_system_lemma(lma_id) {
    return (0 < lma_id && lma_id <= DictDef.kSysDictIdEnd);
  },

  is_user_lemma: function searchUtility_is_user_lemma(lma_id) {
    return (DictDef.kUserDictIdStart <= lma_id &&
            lma_id <= DictDef.kUserDictIdEnd);
  },

  is_composing_lemma: function searchUtility_is_composing_lemma(lma_id) {
    return (DictDef.kLemmaIdComposing == lma_id);
  },

  cmp_lpi_with_psb: function searchUtility_cmp_lpi_with_psb(p1, p2) {
    return SearchUtility.compare(p1.psb, p2.psb);
  },

  cmp_lpi_with_unified_psb:
      function searchUtility_cmp_lpi_with_unified_psb(p1, p2) {
    // The real unified psb is psb1 / lma_len1 and psb2 * lma_len2
    // But we use psb1 * lma_len2 and psb2 * lma_len1 to get better
    // precision.
    var up1 = p1.psb * p2.lma_len;
    var up2 = p2.psb * p1.lma_len;
    return SearchUtility.compare(up1, up2);
  },

  cmp_lpi_with_id: function searchUtility_cmp_lpi_with_id(p1, p2) {
    return SearchUtility.compare(p1.id, p2.id);
  },

  cmp_lpi_with_hanzi: function searchUtility_cmp_lpi_with_hanzi(p1, p2) {
    return SearchUtility.compare(p1.hanzi, p2.hanzi);
  },

  cmp_lpsi_with_str: function searchUtility_cmp_lpsi_with_str(p1, p2) {
    return SearchUtility.compare(p1.str, p2.str);
  },

  cmp_hanzis_1: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 1;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_2: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 2;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_3: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 3;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_4: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 4;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_5: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 5;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_6: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 6;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_7: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 7;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_hanzis_8: function searchUtility_cmp_hanzis_1(p1, p2) {
    var len = 8;
    return SearchUtility.compare(p1.substring(0, len), p2.substring(0, len));
  },

  cmp_npre_by_score: function searchUtility_cmp_npre_by_score(p1, p2) {
    return SearchUtility.compare(p1.psb, p2.psb);
  },

  cmp_npre_by_hislen_score:
      function searchUtility_cmp_npre_by_hislen_score(p1, p2) {
    return SearchUtility.compare(p1.his_len, p2.his_len) ||
      SearchUtility.compare(p1.psb, p2.psb);
  },

  cmp_npre_by_hanzi_score:
      function searchUtility_cmp_npre_by_hanzi_score(p1, p2) {
    return SearchUtility.compare(p1.pre_hzs, p2.pre_hzs) ||
      SearchUtility.compare(p1.psb, p2.psb);
  },


  remove_duplicate_npre:
      function searchUtility_remove_duplicate_npre(npre_items) {
    if (!npre_items) {
      return 0;
    }
    var npre_num = npre_items.length;
    if (!npre_num) {
      return 0;
    }

    npre_items.sort(this.cmp_npre_by_hanzi_score);

    var remain_num = 1;  // The first one is reserved.
    for (var pos = 1; pos < npre_num; pos++) {
      if (npre_items[pos].pre_hzs != npre_items[remain_num - 1].pre_hzs) {
        if (remain_num != pos) {
          npre_items[remain_num] = npre_items[pos];
        }
        remain_num++;
      }
    }
    return remain_num;
  }
};

// Type used to express a lemma and its probability score.
SearchUtility.LmaPsbItem = function lmaPsbItem_constructor() {
};

SearchUtility.LmaPsbItem.prototype = {
  id: 0,
  lma_len: 0,
  // The score, the lower psb, the higher possibility.
  psb: 0,
  // For single character items, we may also need Hanzi.
  // For multiple characer items, ignore it.
  hanzi: ''
};

// LmaPsbItem extended with string.
SearchUtility.LmaPsbStrItem = function lmaPsbStrItem_constructor() {
  this.lpi = new SearchUtility.LmaPsbItem();
};

SearchUtility.LmaPsbStrItem.prototype = {
  /**
   *@type SearchUtility.LmaPsbItem
   */
  lpi: null,
  str: ''
};

SearchUtility.NPredictItem = function nPredictItem_constructor() {
};

SearchUtility.NPredictItem.prototype = {
  psb: 0.0,
  pre_hzs: '',
  // The length of the history used to do the prediction.
  his_len: 0
};

 /**
  * Parameter structure used to extend in a dictionary. All dictionaries
  * receives the same DictExtPara and a dictionary specific MileStoneHandle for
  * extending.
  *
  * When the user inputs a new character, AtomDictBase::extend_dict() will be
  * called at least once for each dictionary.
  *
  * For example, when the user inputs "wm", extend_dict() will be called twice,
  * and the DictExtPara parameter are as follows respectively:
  * 1. splids = {w, m}; splids_extended = 1; ext_len = 1; step_no = 1;
  * splid_end_split = false; id_start = wa(the first id start with 'w');
  * id_num = number of ids starting with 'w'.
  * 2. splids = {m}; splids_extended = 0; ext_len = 1; step_no = 1;
  * splid_end_split = false; id_start = wa; id_num = number of ids starting with
  * 'w'.
  *
  * For string "women", one of the cases of the DictExtPara parameter is:
  * splids = {wo, men}, splids_extended = 1, ext_len = 3 (length of "men"),
  * step_no = 4; splid_end_split = false; id_start = men, id_num = 1.
  */
SearchUtility.DictExtPara = function dictExtPara_constructor() {
  this.splids = [];
  for (var i = 0; i < DictDef.kMaxSearchSteps; i++) {
    this.splids[i] = 0;
  }
};

SearchUtility.DictExtPara.prototype = {
  /**
   * Spelling ids for extending, there are splids_extended + 1 ids in the
   * buffer.
   * For a normal lemma, there can only be kMaxLemmaSize spelling ids in max,
   * but for a composing phrase, there can kMaxSearchSteps spelling ids.
   * @type Array.<number>
   */
  splids: null,

  /**
   * Number of ids that have been used before. splids[splids_extended] is the
   * newly added id for the current extension.
   */
  splids_extended: 0,

  /**
   * The step span of the extension. It is also the size of the string for
   * the newly added spelling id.
   */
  ext_len: 0,

  /**
   * The step number for the current extension. It is also the ending position
   * in the input Pinyin string for the substring of spelling ids in splids[].
   * For example, when the user inputs "women", step_no = 4.
   * This parameter may useful to manage the MileStoneHandle list for each
   * step. When the user deletes a character from the string, MileStoneHandle
   * objects for the the steps after that character should be reset; when the
   * user begins a new string, all MileStoneHandle objects should be reset.
   */
  step_no: 0,

  /**
   * Indicate whether the newly added spelling ends with a splitting character
   * @type boolean
   */
  splid_end_split: 0,

  /**
   * If the newly added id is a half id, id_start is the first id of the
   * corresponding full ids; if the newly added id is a full id, id_start is
   * that id.
   */
  id_star: 0,

  /**
   * If the newly added id is a half id, id_num is the number of corresponding
   * ids; if it is a full id, id_num == 1.
   */
  id_num: 0
};

var MyStdlib = {

  /**
   * Binary search of the key position.
   * @param {string} key The key to search.
   * @param {string} array The sorted char array to be searched.
   * @param {number} start The start position to search.
   * @param {number} count Number of items to search.
   * @param {number} size The size of the each item of the array.
   * @param {function(string, string): number} cmp The comparison function.
   * @return {number} The position of the key if found.
   * Othersize -1.i.
   */
  mybsearchStr:
      function myStdlib_binarySearchStr(key, array, start, count, size, cmp) {
    var doCompare = function compare(a, b) {
      if (cmp) {
        return cmp(a, b);
      } else {
        if (a < b) {
          return -1;
        } else if (a > b) {
          return 1;
        } else {
          return 0;
        }
      }
    };
    var item = function mybsearchStr_item(index) {
      var pos = start + index * size;
      var ret = array.substring(pos, pos + size);
      return ret;
    };
    var left = 0;
    var right = count - 1;
    if (doCompare(key, item(left)) == -1) {
      return -1;
    } else if (doCompare(key, item(right)) == 1) {
      return -1;
    }

    while (right > left) {
      var mid = Math.floor((left + right) / 2);
      var midKey = item(mid);
      if (doCompare(midKey, key) == -1) {
        left = mid + 1;
      } else if (doCompare(midKey, key) == 1) {
        right = mid - 1;
      } else {
        return start + mid * size;
      }
    }

    // left == right == mid
    var leftKey = item(left);
    if (doCompare(leftKey, key) == 0) {
      return start + left * size;
    } else {
      return -1;
    }
  },

  /**
   * Binary search of the key position.
   * @param {*} key The key to search.
   * @param {Array.<*>} array The sorted array to be searched.
   * @param {number} start The start position to search.
   * @param {number} count Number of items to search.
   * @param {function(string, string): number} cmp The comparison function.
   * @return {number} The position of the key if found.
   * Othersize -1.
   */
  mybsearchArray:
      function myStdlib_binarySearchArray(key, array, start, count, cmp) {
    var doCompare = function compare(a, b) {
      if (cmp) {
        return cmp(a, b);
      } else {
        if (a < b) {
          return -1;
        } else if (a > b) {
          return 1;
        } else {
          return 0;
        }
      }
    };
    var item = function mybsearchStr_item(index) {
      return array[index];
    };
    var left = 0;
    var right = count - 1;
    if (doCompare(key, item(left)) == -1) {
      return -1;
    } else if (doCompare(key, item(right)) == 1) {
      return -1;
    }

    while (right > left) {
      var mid = Math.floor((left + right) / 2);
      var midKey = item(mid);
      if (doCompare(midKey, key) == -1) {
        left = mid + 1;
      } else if (doCompare(midKey, key) == 1) {
        right = mid - 1;
      } else {
        return start + mid;
      }
    }

    // left == right == mid
    var leftKey = item(left);
    if (doCompare(leftKey, key) == 0) {
      return start + left;
    } else {
      return -1;
    }
  }
};

// System words' total frequency. It is not the real total frequency, instead,
// It is only used to adjust system lemmas' scores when the user dictionary's
// total frequency changes.
// In this version, frequencies of system lemmas are fixed. We are considering
// to make them changable in next version.
var SYS_DICT_TOTAL_FREQ = 100000000;

var MAX_SEARCH_STEPS = 40;

var DictMatchInfo = function dmi_constructor() {
  this.dict_handles = [0, 0];
};

DictMatchInfo.prototype = {
  // MileStoneHandle objects for the system and user dictionaries.
  dict_handles: null,
  // From which DMI node. -1 means it's from root.
  dmi_fr: -1,
  // The spelling id for the Pinyin string from the previous DMI to this node.
  // If it is a half id like Shengmu, the node pointed by dict_node is the first
  // node with this Shengmu,
  spl_id: 0,
  // What's the level of the dict node. Level of root is 0, but root is never
  // recorded by dict_node.
  dict_level: 0,
  // If this node is for composing phrase, its value is true.
  c_phrase: false,
  // Whether the spl_id is parsed with a split character at the end.
  splid_end_split: false,
  // What's the length of the spelling string for this match, for the whole
  // word.
  splstr_len: 0,
  // Used to indicate whether all spelling ids from the root are full spelling
  // ids. This information is useful for keymapping mode(not finished). Because
  // in this mode, there is no clear boundaries, we prefer those results which
  // have full spelling ids.
  all_full_id: false
};

var MatrixNode = function matrixNode_constructor() {
};

MatrixNode.prototype = {
  id: 0,
  score: 0.0,
  from: null,
  // From which DMI node. Used to trace the spelling segmentation.
  dmi_fr: null,
  step: 0
};

var MatrixRow = function matrixRow_constructor() {
};


MatrixRow.prototype = {
  // The MatrixNode position in the matrix pool
  mtrx_nd_pos: 0,
  // The DictMatchInfo position in the DictMatchInfo pool.
  dmi_pos: 0,
  mtrx_nd_num: 0,
  dmi_num: 15,
  // Used to indicate whether there are dmi nodes in this step with full
  // spelling id. This information is used to decide whether a substring of a
  // valid Pinyin should be extended.
  //
  // Example1: shoudao
  // When the last char 'o' is added, the parser will find "dao" is a valid
  // Pinyin, and because all dmi nodes at location 'd' (including those for
  // "shoud", and those for "d") have Shengmu id only, so it is not necessary
  // to extend "ao", otherwise the result may be "shoud ao", that is not
  // reasonable.
  //
  // Example2: hengao
  // When the last 'o' is added, the parser finds "gao" is a valid Pinyin.
  // Because some dmi nodes at 'g' has Shengmu ids (hen'g and g), but some dmi
  // nodes at 'g' has full ids ('heng'), so it is necessary to extend "ao", thus
  // "heng ao" can also be the result.
  //
  // Similarly, "ganga" is expanded to "gang a".
  //
  // For Pinyin string "xian", because "xian" is a valid Pinyin, because all dmi
  // nodes at 'x' only have Shengmu ids, the parser will not try "x ian" (and it
  // is not valid either). If the parser uses break in the loop, the result
  // always be "xian"; but if the parser uses continue in the loop, "xi an" will
  // also be tried. This behaviour can be set via the function
  // set_xi_an_switch().
  dmi_has_full_id: false,
  // Points to a MatrixNode of the current step to indicate which choice the
  // user selects.
  mtrx_nd_fixed: null
};

// When user inputs and selects candidates, the fixed lemma ids are stored in
// _lmaId of class MatrixSearch, and _fixedLmas is used to indicate how many
// lemmas from the beginning are fixed. If user deletes Pinyin characters one
// by one from the end, these fixed lemmas can be unlocked one by one when
// necessary. Whenever user deletes a Chinese character and its spelling string
// in these fixed lemmas, all fixed lemmas will be merged together into a unit
// named ComposingPhrase with a lemma id kLemmaIdComposing, and this composing
// phrase will be the first lemma in the sentence. Because it contains some
// modified lemmas (by deleting a character), these merged lemmas are called
// sub lemmas (sublma), and each of them are represented individually, so that
// when user deletes Pinyin characters from the end, these sub lemmas can also
// be unlocked one by one.
var ComposingPhrase = function composingPhrase_constructor() {
  this.spl_ids = new Array(MatrixSearch.MAX_ROW_NUM);
  this.spl_start = new Array(MatrixSearch.MAX_ROW_NUM);
  this.chn_str = new Array(MatrixSearch.MAX_ROW_NUM);
  this.sublma_start = new Array(MatrixSearch.MAX_ROW_NUM);
};
ComposingPhrase.prototype = {
  spl_ids: null,
  spl_start: null,
  chn_str: null,      // Chinese string array.
  sublma_start: null, // Counted in Chinese characters.
  sublma_num: 0,
  length: 0          // Counted in Chinese characters.
};

var MatrixSearch = function matrixSearch_constructor() {
  var i = 0;

  this._spl_start = new Array(MatrixSearch.MAX_ROW_NUM);
  this._spl_start = new Array(MatrixSearch.MAX_ROW_NUM);

  this._lmaStart = new Array(MatrixSearch.MAX_ROW_NUM);
  this._lmaId = new Array(MatrixSearch.MAX_ROW_NUM);
};

MatrixSearch.MAX_ROW_NUM = MAX_SEARCH_STEPS;

// The maximum buffer to store LmaPsbItems.
MatrixSearch.MAX_LMA_PSB_ITEMS = 1450;

// How many rows for each step.
MatrixSearch.MAX_NODE_A_ROW = 5;

// The maximum length of the sentence candidates counted in chinese
// characters
MatrixSearch.MAX_SENTENCE_LENGTH = 16;

// The size of the matrix node pool.
MatrixSearch.MTRX_ND_POOL_SIZE = 200;

// The size of the DMI node pool.
MatrixSearch.DMI_POOL_SIZE = 800;

// The maximum buffer to store the prediction items
MatrixSearch.MAX_PRE_ITEMS = 800;

MatrixSearch.prototype = {
  /* ==== Public methods ==== */

  init: function matrixSearch_init(sysDict, userDict) {
    this._allocResource();

    if (!this._dictTrie.load(sysDict, 1, DictDef.kTopScoreLemmaNum)) {
      return false;
    }

    if (!this._userDict.load(userDict, DictDef.kUserDictIdStart,
                             DictDef.kUserDictIdEnd)) {
      return false;
    }

    this._userDict.set_total_lemma_count_of_others(SYS_DICT_TOTAL_FREQ);

    this._initilized = true;
    return true;
  },

  uninit: function matrixSearch_uinit() {
    this.flush_cache();
    this._freeResource();
    this._initilized = false;
  },

  /**
   * Flush cached data to persistent memory. Because at runtime, in order to
   * achieve best performance, some data is only store in memory.
   */
  flush_cache: function matrixSearch_flush_cache() {
    if (this._userDict) {
      this._userDict.flush_cache();
    }
  },

  /**
   * Search a Pinyin string.
   *
   * @param {String} py The Pinyin string.
   * @return {Integer} The position successfully parsed.
   */
  search: function matrixSearch_search(py) {
    if (!this._initilized || py == '') {
      return 0;
    }

    var pyLen = py.length;

    // If the search Pinyin string is too long, it will be truncated.
    if (pyLen > MatrixSearch.MAX_ROW_NUM - 1) {
      py = py.substring(0, MatrixSearch.MAX_ROW_NUM - 1);
      pyLen = MatrixSearch.MAX_ROW_NUM - 1;
    }

    // Compare the new string with the previous one. Find their prefix to
    // increase search efficiency.
    var chPos = 0;
    var len = Math.min(this._pysDecodedLen, pyLen);
    for (chPos = 0; chPos < len; chPos++) {
      if (py.charAt(chPos) != this._pys.charAt(chPos))
        break;
    }

    var clearFix = chPos != this._pysDecodedLen;

    this._resetSearch(chPos, clearFix, false, false);

    this._pys = py;

    while (chPos < pyLen) {
      if (!this._addChar(py.charAt(chPos))) {
        this._pysDecodedLen = chPos;
        break;
      }
      chPos++;
    }

    // Get spelling ids and starting positions.
    this._getSplStartId();

    // If there are too many spellings, remove the last letter until the
    // spelling number is acceptable.
    while (this._spl_idNum > 9) {
      pyLen--;
      this._resetSearch(pyLen, false, false, false);
      this._pys = this._pys.substring(0, pyLen);
      this._getSplStartId();
    }

    this._prepareCandidates();

    return chPos;
  },

  /**
   * Used to delete something in the Pinyin string kept by the engine, and do
   * a re-search.
   *
   * @param {Integer} pos The posistion of char in spelling string to delete,
   * or the position of spelling id in result string to delete.
   * @param {Boolean} isPosInspl_id If isPosInspl_id is false, pos is used to
   * indicate that pos-th Pinyin character needs to be deleted. And if the
   * pos-th character is in the range for the fixed lemmas or composing string,
   * this function will do nothing and just return the result of the previous
   * search. If isPosInspl_id is true, all Pinyin characters for pos-th spelling
   * id needs to be deleted.
   * @param {Boolean} clearFixed If the deleted character(s) is just after a
   * fixed lemma or sub lemma in composing phrase, clearFixed indicates
   * whether we needs to unlock the last fixed lemma or sub lemma.
   * @return {Integer} The new length of Pinyin string kept by the engine which
   * is parsed successfully.
   */
  delSearch: function matrixSearch_delSearch(pos, isPosInspl_id, clearFixed) {

  },

  /**
   * Reset the search space.
   */
  resetSearch: function matrixSearch_resetSearch() {
    if (!this._initilized) {
      return false;
    }

    return true;
  },

  // Get the number of candiates, called after search().
  getCandidateNum: function matrixSearch_getCandidateNum() {
  },

  /**
   * Get the Pinyin string stored by the engine.
   */
  getSpsStr: function matrixSearch_getSpsStr() {

  },

  /**
   * Get a candidate(or choice) string. If full sentence candidate is
   * available, it will be the first one.
   *
   * @param {Integer} candId The id to get a candidate. Started from 0.
   * Usually, id 0 is a sentence-level candidate.
   * @return {String } The candidate string if succeeds, otherwise null.
   */
  getCandidate: function matrixSearch_getCandidate(candId) {

  },

  /**
   * Get the spelling boundaries for the first sentence candidate.
   * The number of valid elements is one more than the return value because the
   * last one is used to indicate the beginning of the next un-input spelling.
   * For a Pinyin "women", the returned array is [0, 2, 5].
   *
   * @return {Array} An array contains the starting position of all the
   * spellings.
   */
  getSplStartPos: function matrixSearch_getSplStartPos() {

  },

  /**
   * Choose a candidate. The decoder will do a search after the fixed position.
   */
  choose: function matrixSearch_choose(candId) {

  },

  /**
   * Get the length of fixed Chinese characters.
   */
  getFixedLen: function matrixSearch_getFixedLen() {

  },

  /**
   * Get prediction candiates based on the given fixed Chinese string as the
   * history.
   *
   * @param {String} fixed The fixed string to do the prediction.
   * @return {Array} The prediction result list of an string array.
   */
  getPredicts: function matrixSearch_getPredicts(fixed) {

  },

  /* ==== Private ==== */

  // Used to indicate whether this object has been initialized.
  _initilized: false,

  // System dictionary
  _dictTrie: null,

  // User dictionary
  _userDict: null,

  // Spelling parser.
  _splParser: null,

  // Pinyin string
  _pys: '',

  // The length of the string that has been decoded successfully.
  _pysDecodedLen: 0,

  _mtrxNdPool: null,
  _mtrxNdPoolUsed: 0,  // How many nodes used in the pool
  _dmiPool: null,
  _dmiPoolUsed: 0,     // How many items used in the pool

  /**
   * The first row is for starting
   * @type MatrixRow[]
   */
  _matrix: null,

  _dep: null,          // Parameter used to extend DMI nodes.

  _npreItems: null,     // Used to do prediction
  _npreItemsLen: 0,

  // The starting positions and lemma ids for the full sentence candidate.
  _lmaIdNum: 0,
  _lmaStart: null,     // Counted in spelling ids.
  _lmaId: null,
  _fixedLmas: 0,

  // If this._fixedLmas is bigger than i,  Element i is used to indicate whether
  // the i'th lemma id in this._lmaId is the first candidate for that step.
  // If all candidates are the first one for that step, the whole string can be
  // decoded by the engine automatically, so no need to add it to user
  // dictionary. (We are considering to add it to user dictionary in the
  // future).
  _fixedLmasNo1: null,

  // Composing phrase
  _c_phrase: null,

  // If _dmiCPhrase is true, the decoder will try to match the
  // composing phrase (And definitely it will match successfully). If it
  // is false, the decoder will try to match lemmas items in dictionaries.
  _dmiCPhrase: true,

  // The starting positions and spelling ids for the first full sentence
  // candidate.
  _spl_idNum: 0,       // Number of spelling ids
  _spl_start: null,     // Starting positions
  _spl_id: null,        // Spelling ids
  // Used to remember the last fixed position, counted in Hanzi.
  _fixedHzs: 0,

  // Lemma Items with possibility score, two purposes:
  // 1. In Viterbi decoding, this buffer is used to get all possible candidates
  // for current step;
  // 2. When the search is done, this buffer is used to get candiates from the
  // first un-fixed step and show them to the user.
  /** @type LmaPsbItem */
  _lpiItems: null,
  _lpiTotal: 0,

  _allocResource: function matrixSearch_allocResource() {
    this._dictTrie = new DictTrie();
    this._userDict = new UserDict();

    // The buffers for search
    this._mtrxNdPool = new Array(MatrixSearch.MTRX_ND_POOL_SIZE);
    this._dmiPool = new Array(MatrixSearch.DMI_POOL_SIZE);
    this._matrix = [];
    for (i = 0; i < MatrixSearch.MAX_ROW_NUM; i++) {
      this._matrix[i] = new MatrixRow();
    }
    this._dep = new SearchUtility.DictExtPara();

    // The prediction buffer
    this._npreItems = new Array(MatrixSearch.MAX_PRE_ITEMS);
    this._npreItemsLen = MatrixSearch.MAX_PRE_ITEMS;
  },

  _freeResource: function matrixSearch_freeResource() {

  },

  // Reset the search space from ch_pos step. For example, if the original
  // input Pinyin is "an", _resetSearch(1) will reset the search space to the
  // result of "a". If the given position is out of range, return false.
  // if clearFixed is true, and the chPos step is a fixed step,
  // clear its fixed status. if clearDmi is true, clear the DMI nodes.
  // If clearMtrx is true, clear the mtrx nodes of this step.
  // The DMI nodes will be kept.
  //
  // Note: this function should not destroy content of _pys.
  _resetSearch: function matrixSearch_resetSearch(chPos, clearFixed,
                                                  clearDmi, clearMtrx) {
  },

  // Prepare candidates from the last fixed hanzi position.
  _prepareCandidates: function matrixSearch_prepareCandidates() {
  },

  // Get spelling start positions and ids. The result will be stored in
  // _spl_idNum, _spl_start[], _spl_id[].
  // _fixedHzs will be also assigned.
  _getSplStartId: function matrixSearch_getSplStartId() {
    this._lmaIdNum = 0;
    this._lmaStart[0] = 0;

    this._spl_idNum = 0;
    this._spl_start[0] = 0;
    if (!this._initilized || 0 == this._pysDecodedLen ||
        0 == this._matrix[this._pysDecodedLen].mtrx_nd_num) {
      return;
    }

    // Calculate number of lemmas and spellings
    // Only scan the part which is not fixed.
    this._lmaIdNum = this._fixedLmas;
    this._spl_idNum = this._fixedHzs;

    var ndPos = this._matrix[this._pysDecodedLen].mtrx_nd_pos;
    while (ndPos != 0) {
      var mtrxNd = this._mtrxNdPool[ndPos];
      if (this._fixedHzs > 0) {
        if (mtrxNd.step <= this._spl_start[this._fixedHzs])
          break;
      }

      // Update the spelling segamentation information
      var wordSplsStrLen = 0;
      var dmi_fr = mtrxNd.dmi_fr;
      if (-1 != dmi_fr) {
        wordSplsStrLen = this._dmiPool[dmi_fr].splstr_len;
      }

      while (-1 != dmi_fr) {
        this._spl_start[this._spl_idNum + 1] = mtrxNd.step -
            (wordSplsStrLen - this._dmiPool[dmi_fr].splstr_len);
        this._spl_id[this._spl_idNum_] = this._dmiPool[dmi_fr].spl_id;
        this._spl_idNum++;
        dmi_fr = this._dmiPool[dmi_fr].dmi_fr;
      }

      // Update the lemma segmentation information
      this._lmaStart[this._lmaIdNum + 1] = this._spl_idNum;
      this._lmaId[this._lmaIdNum] = mtrxNd.id;
      this._lmaIdNum++;

      ndPos = mtrxNd.from;
    }

    var pos;
    var endPos;
    var pos1;
    var pos2;
    var tmp;

    // Reverse the result of spelling info
    endPos = this._fixedHzs + (this._spl_idNum - this._fixedHzs + 1) / 2;
    for (pos = this._fixedHzs; pos < endPos; pos++) {
      if (this._spl_idNum_ + this._fixedHzs - pos != pos + 1) {
        pos1 = pos + 1;
        pos2 = this._spl_idNum - pos + this._fixedHzs;
        tmp = this._spl_start[pos1];
        this._spl_start[pos1] = this._spl_start[pos2];
        this._spl_start[pos2] = tmp;

        pos1 = pos;
        pos2 = this._spl_idNum + this._fixedHzs - pos - 1;
        tmp = this._spl_id[pos1];
        this._spl_id[pos1] = this._spl_id[pos2];
        this._spl_id[pos2] = tmp;
      }
    }

    // Reverse the result of lemma info
    endPos = this._fixedLmas + (this._lmaIdNum - this._fixedLmas + 1) / 2;
    for (pos = this._fixedLmas; pos < endPos; pos++) {
      pos1 = pos + 1;
      pos2 = this._lmaIdNum + this._fixedLmas - pos;
      var tmp = 0;
      if (pos2 > pos1) {
        tmp = this._lmaStart[pos1];
        this._lmaStart[pos1] = this._lmaStart[pos2];
        this._lmaStart[pos2] = tmp;

        pos1 = pos;
        pos2 = this._lmaIdNum - 1 - pos + this._fixedLmas;
        tmp = this._lmaId[pos1];
        this._lmaId[pos1] = this._lmaId[pos2];
        this._lmaId[pos2] = tmp;
      }
    }

    for (pos = this._fixedLmas + 1; pos <= this._lmaIdNum; pos++) {
      if (pos < this._lmaIdNum) {
        this._lmaStart[pos] = this._lmaStart[pos - 1] +
            (this._lmaStart[pos] - this._lmaStart[pos + 1]);
      }
      else {
        this._lmaStart[pos] = this._lmaStart[pos - 1] + this._lmaStart[pos] -
            this._lmaStart[this._fixedLmas];
      }
    }

    // Find the last fixed position
    this._fixedHzs = 0;
    for (pos = this._spl_idNum; pos > 0; pos--) {
      if (null != this._matrix[this._spl_start[pos]].mtrx_nd_fixed) {
        this._fixedHzs = pos;
        break;
      }
    }
  },

  _addChar: function matrixSearch_addChar(ch) {
    if (!this._prepareAddChar(ch)) {
      return false;
    }
    return this._addCharQwerty(ch);
  },

  _prepareAddChar: function matrixSearch_prepareAddChar(ch) {
    if (this._pysDecodedLen >= MatrixSearch.MAX_ROW_NUM - 1 ||
        (!this._splParser.is_valid_to_parse(ch) && ch != '\'')) {
      return false;
    }

    if (this._dmiPoolUsed >= MatrixSearch.DMI_POOL_SIZE) {
      return false;
    }

    this._pys += ch;
    this._pysDecodedLen++;

    var mtrxRow = this._matrix[this._pysDecodedLen];
    mtrxRow.mtrx_nd_pos = this._mtrxNdPoolUsed;
    mtrxRow.mtrx_nd_num = 0;
    mtrxRow.dmi_pos = this._dmiPoolUsed;
    mtrxRow.dmi_num = 0;
    mtrxRow.dmi_has_full_id = false;

    return true;
  },

  // Called after _prepareAddChar, so the input char has been saved.
  _addCharQwerty: function matrixSearch_addCharQwerty(ch) {

  },

  // Is the character in step pos a splitter character?
  // The caller guarantees that the position is valid.
  _isSplitAt: function matrixSearch_isSplitAt(pos) {
    return !this._splParser.is_valid_to_parse(this._pys[pos - 1]);
  }
};


// The number of half spelling ids. For Chinese Pinyin, there 30 half ids.
// See SpellingTrie.h for details.
var kHalfSpellingIdNum = 29;

/**
 * This interface defines the essential metods for all atom dictionaries.
 * Atom dictionaries are managed by the decoder class MatrixSearch.
 *
 * When the user appends a new character to the Pinyin string, all enabled atom
 * dictionaries' extend_dict() will be called at least once to get candidates
 * ended in this step (the information of starting step is also given in the
 * parameter). Usually, when extend_dict() is called, a MileStoneHandle object
 * returned by a previous calling for a earlier step is given to speed up the
 * look-up process, and a new MileStoneHandle object will be returned if
 * the extension is successful.
 *
 * A returned MileStoneHandle object should keep alive until Function
 * reset_milestones() is called and this object is noticed to be reset.
 *
 * Usually, the atom dictionary can use step information to manage its
 * MileStoneHandle objects, or it can make the objects in ascendant order to
 * make the reset easier.
 *
 * When the decoder loads the dictionary, it will give a starting lemma id for
 * this atom dictionary to map a inner id to a global id. Global ids should be
 * used when an atom dictionary talks to any component outside.
 */
var IAtomDictBase = {
  /**
   * Load an atom dictionary from a file.
   *
   * @param {String} file_name The file name to load dictionary.
   * @param {Integer} start_id The starting id used for this atom dictionary.
   * @param {Integer} end_id The end id (included) which can be used for this
   * atom dictionary. User dictionary will always use the last id space, so it
   * can ignore this paramter. All other atom dictionaries should check this
   * parameter.
   * @return {Boolean} true if succeed.
   */
  load_dict: function atomDictBase_load(file_name, start_id, end_id) {},

  /**
   * Close this atom dictionary.
   *
   * @return {Boolean} true if succeed.
   */
  close: function atomDictBase_close() {},

  /**
   * Get the total number of lemmas in this atom dictionary.
   *
   * @return {Integer} The total number of lemmas.
   */
  number_of_lemmas: function atomDictBase_number_of_lemmas() {},

  /**
   * This function is called by the decoder when user deletes a character from
   * the input string, or begins a new input string.
   *
   * Different atom dictionaries may implement this function in different way.
   * an atom dictionary can use one of these two parameters (or both) to reset
   * its corresponding MileStoneHandle objects according its detailed
   * implementation.
   *
   * For example, if an atom dictionary uses step information to manage its
   * MileStoneHandle objects, parameter fromStep can be used to identify which
   * objects should be reset; otherwise, if another atom dictionary does not
   * use the detailed step information, it only uses ascendant handles
   * (according to step. For the same step, earlier call, smaller handle), it
   * can easily reset those MileStoneHandle which are larger than fromHandle.
   *
   * The decoder always reset the decoding state by step. So when it begins
   * resetting, it will call reset_milestones() of its atom dictionaries with
   * the step information, and the MileStoneHandle objects returned by the
   * earliest calling of extend_dict() for that step.
   *
   * If an atom dictionary does not implement incremental search, this function
   * can be totally ignored.
   *
   * @param {number} from_step From which step(included) the MileStoneHandle
   * objects should be reset.
   * @param {number} from_handle The ealiest MileStoneHandle object for step
   * from_step.
   */
  reset_milestones:
      function atomDictBase_reset_milestones(from_step, from_handle) {},

  /**
   * Used to extend in this dictionary. The handle returned should keep valid
   * until reset_milestones() is called.
   *
   * @param {Integer} from_handle Its previous returned extended handle without
   * the new spelling id, it can be used to speed up the extending.
   * @param {SearchUtility.DictExtPara} dep The paramter used for extending.
   * @return {handle: Integer, items: LmaPsbItem[]} . handle is the new mile
   * stone for this extending. 0 if fail. items is filled in with the lemmas
   * matched.
   */
  extend_dict: function atomDictBase_extend_dict(from_handle, dep) {},

  /**
   * Get lemma items with scores according to a spelling id stream.
   * This atom dictionary does not need to sort the returned items.
   *
   * @param {String} spl_idStr The spelling id stream string.
   * @return {LmaPsbItem[]} The array of matched items.
   */
  get_lpis: function atomDictBase_get_lpis(splid_str) {},

  /**
   * Get a lemma string (The Chinese string) by the given lemma id.
   *
   * @param {Integer} lemmaId The lemma id to get the string.
   */
  get_lemma_str: function atomDictBase_get_lemma_str(id_lemma) {},

  /**
   * Get the full spelling ids for the given lemma id.
   *
   * @param {Integer} id_lemma The lemma id to get the result.
   * @param {Integer[]} splids The buffer of the spl_ids. There may be half ids
   * in spl_ids to be updated to full ids。.
   * @return {Integer} The number of ids in the buffer.
   */
  get_lemma_splids: function atomDictBase_get_lemma_splids(id_lemma, splids) {},

  /**
   * Function used for prediction.
   * No need to sort the newly added items.
   *
   * @param {String} last_hzs The last n Chinese characters(called Hanzi), its
   * length should be less than or equal to kMaxPredictSize.
   * @param {number} used The number of items have been used from the
   * beiginning of buffer. An atom dictionary can just ignore it.
   * @return {NPredictItem[]} The array of prediction result from this atom
   * dictionary.
   */
  predict: function atomDictBase_predict(last_hzs, used) {},

  /**
   * Add a lemma to the dictionary. If the dictionary allows to add new
   * items and this item does not exist, add it.
   *
   * @param {String} splids The Chinese string of the lemma.
   * @param {Integer[]} splids The spelling ids of the lemma.
   * @param {Integer} count The frequency count for this lemma.
   * @return {Integer} The id if succeed, 0 if fail.
   */
  put_lemma: function atomDictBase_put_lemma(lemma_str, splids, count) {},

  /**
   * Update a lemma's occuring count.
   *
   * @param {number} lemma_id The lemma id to update.
   * @param {number} delta_count The frequnecy count to ajust.
   * @param {boolean} selected Indicate whether this lemma is selected by user
   * and submitted to target edit box.
   * @return {integer} The id if succeed, 0 if fail.
   */
  update_lemma:
      function atomDictBase_update_lemma(lemma_id, delta_count, selected) {},

  /**
   * Get the lemma id for the given lemma.
   *
   * @param {string} lemma_str The Chinese string of the lemma.
   * @param {Array.<number>} splids The spelling ids of the lemma.
   * @return {number} The matched lemma id, or 0 if fail.
   */
  get_lemma_id: function atomDictBase_get_lemma_id(lemma_str, splids) {},

  /**
   * Get the lemma score.
   *
   * @param {number} lemma_id The lemma id to get score.
   * @return {number} The score of the lemma, or 0 if fail.
   */
  get_lemma_score_by_id:
      function atomDictBase_get_lemma_score_by_id(lemma_id) {},

  /**
   * Get the lemma score.
   *
   * @param {String} lemma_str The Chinese string of the lemma.
   * @param {Integer[]} splids The spelling ids of the lemma.
   * @return {Integer} The score of the lamm, or 0 if fail.
   */
  get_lemma_score_by_content:
      function atomDictBase_get_lemma_score_by_content(lemma_str, splids) {},

  /**
   * If the dictionary allowed, remove a lemma from it.
   *
   * @param {Integer} lemmaId The id of the lemma to remove.
   * @return {Boolean} true if succeed.
   */
  remove_lemma: function atomDictBase_remove_lemma(lemma_id) {},

  /**
   * Get the total occuring count of this atom dictionary.
   *
   * @return {Integer} The total occuring count of this atom dictionary.
   */
  get_total_lemma_count: function atomDictBase_get_total_lemma_count() {},

  /**
   * Set the total occuring count of other atom dictionaries.
   *
   * @param {Integer} count The total occuring count of other atom dictionaies.
   */
  set_total_lemma_count_of_others:
      function atomDictBase_set_total_lemma_count_of_others(count) {},

  /**
   * Notify this atom dictionary to flush the cached data to persistent storage
   * if necessary.
   */
  flush_cache: function atomDictBase_flush_cache() {}
};

var DictTrie = function dictTrie_constructor() {
};

DictTrie.kMaxMileStone = 100;
DictTrie.kMaxParsingMark = 600;
DictTrie.kFirstValidMileStoneHandle = 1;

DictTrie.ParsingMark = function parsingMark_constructor(offset, num) {
  this.node_offset = offset;
  this.node_num = num;
};

DictTrie.ParsingMark.prototype = {
  node_offset: 0,

 /**
  * Number of nodes with this spelling id given
  * by spl_id. If spl_id is a Shengmu, for nodes
  * in the first layer of DictTrie, it equals to
  * SpellingTrie::shm2full_num(); but for those
  * nodes which are not in the first layer,
  * node_num < SpellingTrie::shm2full_num().
  * For a full spelling id, node_num = 1;
  */
  node_num: 0
};

/**
 * Used to indicate an extended mile stone.
 * An extended mile stone is used to mark a partial match in the dictionary
 * trie to speed up further potential extending.
 * For example, when the user inputs "w", a mile stone is created to mark the
 * partial match status, so that when user inputs another char 'm', it will be
 * faster to extend search space based on this mile stone.
 * For partial match status of "wm", there can be more than one sub mile
 * stone, for example, "wm" can be matched to "wanm", "wom", ..., etc, so
 * there may be more one parsing mark used to mark these partial matchings.
 * A mile stone records the starting position in the mark list and number of
 * marks.
 */
DictTrie.MileStone = function mileStone_constructor(start, num) {
  this.mark_start = start;
  this.mark_num = num;
};

DictTrie.MileStone.prototype = {
  mark_start: 0,
  mark_num: 0
};

DictTrie.prototype = {
  // Implements IAtomDictBase
  __proto__: IAtomDictBase,

  /* ==== Public ==== */

  /**
   * Construct the tree from the file fn_raw.
   * fn_validhzs provide the valid hanzi list. If fn_validhzs is
   * NULL, only chars in GB2312 will be included.
   */
  build_dict: function dictTrie_build_dict(fn_raw, fn_validhzs) {
    return false;
  },

  /**
   * Save the binary dictionary
   * Actually, the SpellingTrie/DictList instance will be also saved.
   */
  save_dict: function dictTrie_save_dict(filename) {
    return false;
  },

  convert_to_hanzis: function dictTrie_convert_to_hanzis(str) {

  },

  /**
   * Load a binary dictionary
   * The SpellingTrie instance/DictList will be also loaded
   * @override
   */
  load_dict: function dictTrie_load(file_name, start_id, end_id) {
  },

  /**
   * @override
   */
  close_dict: function dictTrie_close_dict() {
    return true;
  },

  /**
   * @override
   */
  number_of_lemmas: function dictTrie_number_of_lemmas() {
    return 0;
  },

  /**
   * @override
   */
  reset_milestones:
      function dictTrie_reset_milestones(from_step, from_handle) {
  },

  /**
   * @override
   */
  extend_dict: function dictTrie_extend_dict(from_handle, dep) {},

  /**
   * @override
   */
  get_lpis: function dictTrie_get_lpis(splid_str) {},

  /**
   * @override
   */
  get_lemma_str: function dictTrie_get_lemma_str(id_lemma) {},

  /**
   * @override
   */
  get_lemma_splids: function dictTrie_get_lemma_splids(id_lemma, splids) {},

  /**
   * @override
   */
  predict: function dictTrie_predict(last_hzs, used) {},

  /**
   * @override
   */
  put_lemma: function dictTrie_put_lemma(lemma_str, splids, count) {
    return 0;
  },

  /**
   * @override
   */
  update_lemma:
      function dictTrie_update_lemma(lemma_id, delta_count, selected) {
    return 0;
  },

  /**
   * @override
   */
  get_lemma_id: function dictTrie_get_lemma_id(lemma_str, splids) {
    return 0;
  },

  /**
   * @override
   */
  get_lemma_score_by_id:
      function dictTrie_get_lemma_score_by_id(lemma_id) {
    return 0;
  },

  /**
   * @override
   */
  get_lemma_score_by_content:
      function dictTrie_get_lemma_score_by_content(lemma_str, splids) {
    return 0;
  },

  /**
   * @override
   */
  remove_lemma: function dictTrie_remove_lemma(lemma_id) {
    return false;
  },

  /**
   * @override
   */
  get_total_lemma_count: function dictTrie_get_total_lemma_count() {
    return 0;
  },

  /**
   * @override
   */
  set_total_lemma_count_of_others:
      function dictTrie_set_total_lemma_count_of_others(count) {},

  /**
   * @override
   */
  flush_cache: function dictTrie_flush_cache() {},

  get_lemma_id_by_str: function dictTrie_get_lemma_id_by_str(lemma_str) {

  },

  /**
   * Fill the lemmas with highest scores to the prediction buffer.
   * his_len is the history length to fill in the prediction buffer.
   * @param {Array.<NPredictItem>} npre_items The buffer to be filled.
   * @param {number} used The number of items have been used from the
   * beiginning of buffer.
   * @param {number} The number of lemmas filled.
   */
  predict_top_lmas:
      function dictTrie_predict_top_lmas(his_len, npre_items, used) {

  },

  /* ==== Private ==== */

  /**
   * @type DictList
   */
  dict_list_: null,

  /**
   * @type SpellingTrie
   */
  spl_trie_: null,

  /**
   * Nodes for root and the first layer.
   * @type Array.<DictDef.LmaNodeLE0>
   */
  root_: null,

  /**
   * Nodes for other layers.
   * @type Array.<DictDef.LmaNodeGE1>
   */
  nodes_ge1_: null,

  /**
   * An quick index from spelling id to the LmaNodeLE0 node buffer, or
   * to the root_ buffer.
   * Index length:
   * SpellingTrie::get_instance().get_spelling_num() + 1. The last one is used
   * to get the end.
   * All Shengmu ids are not indexed because they will be converted into
   * corresponding full ids.
   * So, given an id splid, the son is:
   * root_[splid_le0_index_[splid - kFullSplIdStart]]
   * @type Array.<number>
   */
  splid_le0_index_: null,

  lma_node_num_le0_: 0,
  lma_node_num_ge1_: 0,

  /**
   * The first part is for homophnies, and the last top_lma_num_ items are
   * lemmas with highest scores.
   * @type Array
   */
  lma_idx_buf_: null,
  // The total size of lma_idx_buf_ in byte.
  lma_idx_buf_len_: 0,
  // Total number of lemmas in this dictionary.
  total_lma_num_: 0,
  // Number of lemma with highest scores.
  top_lmas_num_: 0,

  /**
   * Parsing mark list used to mark the detailed extended statuses.
   * @type Array.<ParsingMark>
   */
  parsing_marks_: null,

  /**
   * The position for next available mark.
   */
  parsing_marks_pos_: 0,

  /**
   * Mile stone list used to mark the extended status.
   * @type Array.<MileStone>
   */
  mile_stones_: null,

  /**
   * The position for the next available mile stone. We use positions (except 0)
   * as handles.
   * @type number
   */
  mile_stones_pos_: null,

  /**
   * Get the offset of sons for a node.
   * @param {LmaNodeGE1} node The given node.
   * @return {number} The offset of the sons.
   */
  get_son_offset: function dictTrie_get_son_offset(node) {

  },

  /**
   * Get the offset of homonious ids for a node.
   * @param {LmaNodeGE1} node The given node.
   * @return {number} The offset.
   */
  get_homo_idx_buf_offset: function dictTrie_get_homo_idx_buf_offset(node) {

  },

  /**
   * Get the lemma id by the offset.
   */
  get_lemma_id_by_offset: function dictTrie_get_lemma_id_by_offset(id_offset) {

  },

  load_dict_by_fp: function dictTrie_load_dict_by_fp(fp) {
    return false;
  },

  /**
   * Given a LmaNodeLE0 node, extract the lemmas specified by it, and fill
   * them into the lpi_items buffer.
   * @param {Array.<LmaPsbItem>} lpi_items The buffer to be filled.
   * @param {number} start The position to start filling.
   * @param {number} max_size The maximum number of items which can be filled.
   * @param {LmaNodeLE0} node The given LmaNodeLE0 node.
   * @return {number} The number of lemmas.
   */
  fill_lpi_buffer_le0:
      function dictTrie_fill_lpi_buffer_le0(lpi_items, start, max_size, node) {

  },

  /**
   * Given a LmaNodeGE1 node, extract the lemmas specified by it, and fill
   * them into the lpi_items buffer.
   * This function is called by inner functions extend_dict0(), extend_dict1()
   * and extend_dict2().
   * @param {Array.<LmaPsbItem>} lpi_items The lemmas buffer.
   * @param {number} start The position to start filling.
   * @param {number} max_size The maximum number of items which can be filled.
   * @param {LmaNodeGE1} node The given LmaNodeGE1 node.
   * @return {number} The number of lemmas.
   */
  fill_lpi_buffer_ge1:
    function dictTrie_fill_lpi_buffer_ge1(lpi_items, start, max_size,
                                          homo_buf_off, node, lma_len) {
  },

  /**
   * Extend in the trie from level 0.
   * @param {number} from_handle The mile stone handle from which we extend.
   * @param {SearchUtility.DictExtPara} dep Extra dictionary parameters.
   * @param {Array.<LmaPsbItem>} lpi_items The buffer to save the result.
   * @param {number} start The start position of the buffer.
   * @param {number} lpi_max The maximum number of items to save.
   * @return {{handle: number, lpi_num: number}} handle - The mile stone handle,
   *    lpi_num - The number of items saved.
   */
  extend_dict0: function dictTrie_extend_dict0(from_handle, dep, lpi_items,
                                               start, lpi_max) {

  },

  /**
   * Extend in the trie from level 1.
   * @param {number} from_handle The mile stone handle from which we extend.
   * @param {SearchUtility.DictExtPara} dep Extra dictionary parameters.
   * @param {Array.<LmaPsbItem>} lpi_items The buffer to save the result.
   * @param {number} start The start position of the buffer.
   * @param {number} lpi_max The maximum number of items to save.
   * @return {{handle: number, lpi_num: number}} handle - The mile stone handle,
   *    pi_num - The number of items saved.
   */
  extend_dict1: function dictTrie_extend_dict1(from_handle, dep, lpi_items,
                                               start, lpi_max) {

  },


  /**
   * Extend in the trie from level 2.
   * @param {number} from_handle The mile stone handle from which we extend.
   * @param {DictDef.DictExtPara} dep Extra dictionary parameters.
   * @param {Array.<LmaPsbItem>} lpi_items The buffer to save the result.
   * @param {number} start The start position of the buffer.
   * @param {number} lpi_max The maximum number of items to save.
   * @return {{handle: number, lpi_num: number}} handle - The mile stone handle,
   *    lpi_num - The number of items saved.
   */
  extend_dict2: function dictTrie_extend_dict2(from_handle, dep, lpi_items,
                                               start, lpi_max) {

  },

  /**
   * Try to extend the given spelling id buffer, and if the given id_lemma can
   * be successfully gotten, return true;
   * The given spelling ids are all valid full ids.
   * @param {Array.<number>} splids The given spelling id buffer.
   */
  try_extend: function dictTrie_try_extend(splids, id_lemma) {

  },

  save_dict_by_fp: function dictTrie_save_dict_by_fp(fp) {
    return false;
  }
};

var DictBuilder = function dictBuilder_constructor() {
};

DictBuilder.prototype = {
  /* ==== Public ==== */

  /**
   * Build dictionary trie from the file fn_raw. File fn_validhzs provides
   * valid chars. If fn_validhzs is NULL, only chars in GB2312 will be
   * included.
   * @param {string} fn_raw The raw data file name.
   * @param {string} fn_validhzs The valid hanzi file name.
   * @param {DictTrie} dict_trie The DictTrie to be built.
   * @param {function(boolean)} callback The function object that is
   *    called when the operation is finished. The boolean parameter indicates
   *    whether the dict is built successfully.
   */
  build_dict: function dictBuilder_build_dict(fn_raw, fn_validhzs, dict_trie,
                                              callback) {
    var self = this;
    var isOk = false;
    function doCallback() {
      if (callback) {
        callback(isOk);
      }
    }
    if (!fn_raw) {
      doCallback();
      return;
    }

    // Open the raw dict files

    var rawStr = '';
    var validhzsStr = '';

    var taskQueue = new TaskQueue(
        function taskQueueOnCompleteCallback(queueData) {
      isOk = self.build_dict_internal(rawStr, validhzsStr, dict_trie);
      doCallback();
    });

    var processNextWithDelay =
        function dictBuilder_rocessNextWithDelay() {
      if (typeof setTimeout != 'undefined') {
        setTimeout(function nextTask() {
          taskQueue.processNext();
        }, 0);
      } else {
        taskQueue.processNext();
      }
    };

    taskQueue.push(function initIdb(taskQueue, taskData) {
      FileSystemService.read(fn_raw, function rawReadCallback(str) {
        rawStr = str;
        processNextWithDelay();
      });
    });

    if (fn_validhzs) {
      taskQueue.push(function initIdb(taskQueue, taskData) {
        FileSystemService.read(fn_validhzs, function validhzsReadCallback(str) {
          validhzsStr = str;
          processNextWithDelay();
        });
      });
    }

    taskQueue.processNext();
  },

  /* ==== Private ==== */

  /**
   * The raw lemma array buffer.
   * @type Array.<DictDef.LemmaEntry>
   */
  lemma_arr_: null,

  /**
   * Used to store all possible single char items.
   * Two items may have the same Hanzi while their spelling ids are different.
   * @type Array.<DictDef.SingleCharItem>
   */
  scis_: null,

  /**
   * In the tree, root's level is -1.
   * Lemma nodes for root, and level 0
   * @type Array.<DictDef.LmaNodeLE0>
   */
  lma_nodes_le0_: null,

  /**
   * Lemma nodes for layers whose levels are deeper than 0.
   * @type Array.<DictDef.LmaNodeGE1>
   */
  lma_nodes_ge1_: null,

  // Number of used lemma nodes
  lma_nds_used_num_le0_: 0,
  lma_nds_used_num_ge1_: 0,

  /**
   * Used to store homophonies' ids.
   * @type Array.<number>
   */
  homo_idx_buf_: null,

  // Number of homophonies each of which only contains one Chinese character.
  homo_idx_num_eq1_: 0,

  // Number of homophonies each of which contains more than one character.
  homo_idx_num_gt1_: 0,

  /**
   * The items with highest scores.
   * @type Array.<LemmaEntry>
   */
  top_lmas_: null,
  top_lmas_num_: 0,

  /**
   * @type SpellingTable
   */
  spl_table_: null,

  /**
   * @type SpellingParser
   */
  spl_parser_: null,

  // Used for statistics

  /**
   * @type Array.<number>
   */
  max_sonbuf_len_: null,

  /**
   * @type Array.<number>
   */
  max_homobuf_len_: null,

  /**
   * @type Array.<number>
   */
  total_son_num_: null,

  /**
   * @type Array.<number>
   */
  total_node_hasson_: null,

  /**
   * @type Array.<number>
   */
  total_sonbuf_num_: null,

  /**
   * @type Array.<number>
   */
  total_sonbuf_allnoson_: null,

  /**
   * @type Array.<number>
   */
  total_node_in_sonbuf_allnoson_: null,

  /**
   * @type Array.<number>
   */
  total_homo_num_: null,

  // Number of son buffer with only 1 son
  sonbufs_num1_: 0,

  // Number of son buffer with more 1 son;
  sonbufs_numgt1_: 0,

  total_lma_node_num_: 0,

  stat_init: function dictBuilder_stat_init() {
    this.max_sonbuf_len_ = [];
    this.max_homobuf_len_ = [];
    this.total_son_num_ = [];
    this.total_node_hasson_ = [];
    this.total_sonbuf_num_ = [];
    this.total_sonbuf_allnoson_ = [];
    this.total_node_in_sonbuf_allnoson_ = [];
    this.total_homo_num_ = [];
    for (var pos = 0; pos < DictDef.kMaxLemmaSize; pos++) {
      this.max_sonbuf_len_[pos] = 0;
      this.max_homobuf_len_[pos] = 0;
      this.total_son_num_[pos] = 0;
      this.total_node_hasson_[pos] = 0;
      this.total_sonbuf_num_[pos] = 0;
      this.total_sonbuf_allnoson_[pos] = 0;
      this.total_node_in_sonbuf_allnoson_[pos] = 0;
      this.total_homo_num_[pos] = 0;
    }

    this.sonbufs_num1_ = 0;
    this.sonbufs_numgt1_ = 0;
    this.total_lma_node_num_ = 0;
  },

  stat_print: function dictBuilder_stat_print() {
    var line = '';
    debug('\n------------STAT INFO-------------');
    debug('[root is layer -1]');
    debug('.. max_sonbuf_len per layer(from layer 0):');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.max_sonbuf_len_[i] + ', ';
    }
    debug(line + '-,');

    debug('.. max_homobuf_len per layer:\n   -, ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.max_homobuf_len_[i] + ', ';
    }
    debug(line);

    debug('.. total_son_num per layer:\n   ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.total_son_num_[i] + ', ';
    }
    debug(line + '-,');

    debug('.. total_node_hasson per layer:\n   1, ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.total_node_hasson_[i] + ', ';
    }
    debug(line);

    debug('.. total_sonbuf_num per layer:\n   ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.total_sonbuf_num_[i] + ', ';
    }
    debug(line + '-,');

    debug('.. total_sonbuf_allnoson per layer:\n   ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.total_sonbuf_allnoson_[i] + ', ';
    }
    debug(line + '-,');

    debug('.. total_node_in_sonbuf_allnoson per layer:\n   ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.total_node_in_sonbuf_allnoson_[i] + ', ';
    }
    debug(line + '-,');

    debug('.. total_homo_num per layer:\n   0, ');
    line = '';
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      line += this.total_homo_num_[i] + ', ';
    }
    debug(line);

    debug('.. son buf allocation number with only 1 son: ' +
          this.sonbufs_num1_);
    debug('.. son buf allocation number with more than 1 son: ' +
          this.sonbufs_numgt1_);
    debug('.. total lemma node number: ' + (this.total_lma_node_num_ + 1));
  },

  /**
   * Build dictionary trie from raw dict string. String validhzs provides
   * valid chars. If validhzs is empty, only chars in GB2312 will be
   * included.
   * @param {string} raw The raw dict data string.
   * @param {string} validhzs The valid hanzi string.
   * @param {DictTrie} dict_trie The DictTrie to be built.
   * @return {boolean} true if succeed.
   */
  build_dict_internal:
      function dictBuilder_build_dict(raw, validhzs, dict_trie) {
    if (!raw) {
      return false;
    }

    var lemma_num = this.read_raw_dict(raw, validhzs, 240000);
    if (0 == lemma_num)
      return false;

    // Arrange the spelling table, and build a spelling tree
    var spl_buf = this.spl_table_.arrange();

    var spl_trie = SpellingTrie.get_instance();

    if (!spl_trie.construct(spl_buf,
                            this.spl_table_.get_score_amplifier(),
                            this.spl_table_.get_average_score())) {
      return false;
    }

    debug('spelling tree construct successfully.\n');

    // Convert the spelling string to idxs
    for (var i = 0; i < lemma_num; i++) {
      var lemma = this.lemma_arr_[i];
      var hz_str_len = lemma.hanzi_str.length;
      for (var hz_pos = 0; hz_pos < hz_str_len; hz_pos++) {
        var spl_idxs = [0, 0];
        var spl_start_pos = [0, 0, 0];
        var is_pre = true;
        var spl_idx_num = 0;
        var ret = this.spl_parser_.splstr_to_idxs(
          lemma.pinyin_str[hz_pos]);
        is_pre = ret.last_is_pre;
        spl_idxs = ret.spl_idx;
        spl_start_pos = ret.start_pos;

        if (spl_trie.is_half_id(spl_idxs[0])) {
          var ret = spl_trie.half_to_full(spl_idxs[0]);
          var num = ret.num;
          spl_idxs[0] = ret.spl_id_start;
        }

        lemma.spl_idx_arr[hz_pos] = spl_idxs[0];
      }
    }

    // Sort the lemma items according to the hanzi, and give each unique item a
    // id
    this.sort_lemmas_by_hz();

    var scis_num = this.build_scis();

    // Construct the dict list
    dict_trie.dict_list_ = new DictList();
    var dl_success =
      dict_trie.dict_list_.init_list(this.scis_, this.lemma_arr_);
    assert(dl_success, 'build_dict_internal assertion error.' +
           'Failed to initialize DictList');

    // Construct the NGram information
    var ngram = NGram.get_instance();
    ngram.build_unigram(this.lemma_arr_);

    // sort the lemma items according to the spelling idx string
    this.lemma_arr_.sort(function compare_py(p1, p2) {
      return SearchUtility.compare(p1.spl_idx_arr, p2.spl_idx_arr) ||
        SearchUtility.compare(p1.freq, p2.freq);
    });

    this.get_top_lemmas();

    this.stat_init();

    this.lma_nds_used_num_le0_ = 1;  // The root node
    var dt_success = this.construct_subset(this.lma_nodes_le0_[0],
                                       this.lemma_arr_, 0, lemma_num, 0);
    if (!dt_success) {
      free_resource();
      return false;
    }

    this.stat_print();

    // Remove empty nodes.
    this.lma_nodes_le0_.length = this.lma_nds_used_num_le0_;
    this.lma_nodes_ge1_.length = this.lma_nds_used_num_ge1_;
    this.homo_idx_buf_.length = this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_;

    // Move the node data and homo data to the DictTrie
    dict_trie.root_ = this.lma_nodes_le0_;
    dict_trie.nodes_ge1_ = this.lma_nodes_ge1_;
    var lma_idx_num = this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_ +
      this.top_lmas_num_;
    dict_trie.lma_idx_buf_ = '';
    dict_trie.lma_node_num_le0_ = this.lma_nds_used_num_le0_;
    dict_trie.lma_node_num_ge1_ = this.lma_nds_used_num_ge1_;
    dict_trie.lma_idx_buf_len_ = lma_idx_num * DictDef.kLemmaIdSize;
    dict_trie.top_lmas_num_ = this.top_lmas_num_;

    dict_trie.root_ = this.lma_nodes_le0_;
    dict_trie.nodes_ge1_ = this.lma_nodes_ge1_;

    var n = this.homo_idx_buf_.length;
    for (var pos = 0; pos < n; pos++) {
      dict_trie.lma_idx_buf_ += this.id_to_charbuf(this.homo_idx_buf_[pos]);
    }

    n = this.top_lmas_num_;
    for (var pos = 0; pos < n; pos++) {
      var idx = this.top_lmas_[pos].idx_by_hz;
      dict_trie.lma_idx_buf_ += this.id_to_charbuf(idx);
    }

    debug('homo_idx_num_eq1_: ' + this.homo_idx_num_eq1_);
    debug('homo_idx_num_gt1_: ' + this.homo_idx_num_gt1_);
    debug('top_lmas_num_: ' + this.top_lmas_num_);

    debug('Building dict succeds');
    return dt_success;
  },

  /**
   * Convert id to char array.
   */
  id_to_charbuf: function dictBuilder_id_to_charbuf(buf, start, id) {
    var str = '';
    for (var pos = 0; pos < DictDef.kLemmaIdSize; pos++) {
      str += String.fromCharCode((id >> (pos * 8)) & 0xff);
    }
    return str;
  },

  /**
   * Update the offset of sons for a node.
   * @param {DictDef.LmaNodeGE1} node The node to be updated.
   * @param {number} offset The offset.
   */
  set_son_offset: function dictBuilder_set_son_offset(node, offset) {
    node.son_1st_off_l = offset;
    node.son_1st_off_h = offset >> 16;
  },

  /**
   * Update the offset of homophonies' ids for a node.
   * @param {DictDef.LmaNodeGE1} node The node to be updated.
   * @param {number} offset The offset.
   */
  set_homo_id_buf_offset:
      function dictBuilder_set_homo_id_buf_offset(node, offset) {
    node.homo_idx_buf_off_l = offset;
    node.homo_idx_buf_off_h = offset >> 16;
  },

  /**
   * Format a speling string.
   * All spelling strings will be converted to upper case, except that
   * spellings started with "ZH"/"CH"/"SH" will be converted to
   * "Zh"/"Ch"/"Sh"
   */
  format_spelling_str: function dictBuilder_format_spelling_str(spl_str) {
    if (!spl_str) {
      return '';
    }
    var formatted = spl_str.trim().toUpperCase().replace(/^([CSZ])H/, '$1h');
    return formatted;
  },

  /**
   * Sort the lemma_arr by the hanzi string, and give each of unique items
   * a id. Why we need to sort the lemma list according to their Hanzi string
   * is to find items started by a given prefix string to do prediction.
   * Actually, the single char items are be in other order, for example,
   * in spelling id order, etc.
   * @return {number} Return value is next un-allocated idx available.
   */
  sort_lemmas_by_hz: function dictBuilder_sort_lemmas_by_hz() {
    if (null === this.lemma_arr_) {
      return 0;
    }

    var lemma_num = this.lemma_arr_.length;
    if (0 == lemma_num) {
      return 0;
    }

    this.lemma_arr_.sort(function cmp_lemma_entry_hzs(a, b) {
      var strA = a.hanzi_str;
      var strB = b.hanzi_str;
      return SearchUtility.compare(strA.length, strB.length) ||
        SearchUtility.compare(strA, strB);
    });

    this.lemma_arr_[0].idx_by_hz = 1;
    var idx_max = 1;
    for (var i = 1; i < lemma_num; i++) {
      idx_max++;
      this.lemma_arr_[i].idx_by_hz = idx_max;
    }
    return idx_max + 1;
  },


  /**
   * Build the SingleCharItem list, and fill the hanzi_scis_ids in the
   * lemma buffer lemma_arr_.
   * This function should be called after the lemma array is ready.
   * @return {number} Return the number of unique SingleCharItem elements.
   */
  build_scis: function dictBuilder_build_scis() {
    debug('build_scis');
    var lemma_num = this.lemma_arr_ === null ? 0 : this.lemma_arr_.length;
    var scis_num = this.scis_ === null ? 0 : this.scis_.length;
    if (null === this.scis_ || lemma_num * DictDef.kMaxLemmaSize > scis_num)
      return 0;

    var spl_trie = SpellingTrie.get_instance();
    var sci = null;

    // This first one is blank, because id 0 is invalid.
    sci = new DictDef.SingleCharItem();
    sci.freq = 0;
    sci.hz = 0;
    sci.splid.full_splid = 0;
    sci.splid.half_splid = 0;
    this.scis_[0] = sci;
    scis_num = 1;

    // Copy the hanzis to the buffer
    for (var pos = 0; pos < lemma_num; pos++) {
      var lemma = this.lemma_arr_[pos];
      var hz_num = lemma.hanzi_str.length;
      for (var hzpos = 0; hzpos < hz_num; hzpos++) {
        sci = new DictDef.SingleCharItem();
        sci.hz = lemma.hanzi_str[hzpos];
        sci.splid.full_splid = lemma.spl_idx_arr[hzpos];
        sci.splid.half_splid =
            spl_trie.full_to_half(lemma.spl_idx_arr[hzpos]);
        if (1 == hz_num) {
          sci.freq = lemma.freq;
        } else {
          sci.freq = 0.000001;
        }
        this.scis_[scis_num] = sci;
        scis_num++;
      }
    }

    // remove empty elements
    this.scis_.length = scis_num;

    this.scis_.sort(function cmp_scis_hz_splid_freq(s1, s2) {
      return SearchUtility.compare(s1.hz, s2.hz) ||
        SearchUtility.compare(s1.splid.half_splid, s2.splid.half_splid) ||
        SearchUtility.compare(s1.splid.full_splid, s2.splid.full_splid) ||
        SearchUtility.compare(s2.freq, s1.freq);
    });

    // Remove repeated items
    var unique_scis_num = 1;
    for (var pos = 1; pos < scis_num; pos++) {
      if (this.scis_[pos].hz == this.scis_[pos - 1].hz &&
          this.scis_[pos].splid.full_splid ==
          this.scis_[pos - 1].splid.full_splid) {
        continue;
      }
      this.scis_[unique_scis_num] = this.scis_[pos];
      unique_scis_num++;
    }
    this.scis_.length = unique_scis_num;
    scis_num = unique_scis_num;

    // Update the lemma list.
    for (var pos = 0; pos < lemma_num; pos++) {
      var lemma = this.lemma_arr_[pos];
      var hz_num = lemma.hanzi_str.length;
      for (var hzpos = 0; hzpos < hz_num; hzpos++) {
        var key = new DictDef.SingleCharItem();
        key.hz = lemma.hanzi_str[hzpos];
        key.splid.full_splid = lemma.spl_idx_arr[hzpos];
        key.splid.half_splid = spl_trie.full_to_half(key.splid.full_splid);

        var found = MyStdlib.mybsearchArray(key, this.scis_, 0, unique_scis_num,
          function cmp_scis_hz_splid(s1, s2) {
            return SearchUtility.compare(s1.hz, s2.hz) ||
            SearchUtility.compare(s1.splid.half_splid, s2.splid.half_splid) ||
            SearchUtility.compare(s1.splid.full_splid, s2.splid.full_splid);
          });

        assert(found != -1, 'build_scis assertion error. Cannot find ' +
               JSON.stringify(key));

        this.lemma_arr_[pos].hanzi_scis_ids[hzpos] = found;
        this.lemma_arr_[pos].spl_idx_arr[hzpos] =
          this.scis_[found].splid.full_splid;
      }
    }

    return scis_num;
  },

  /** Construct a subtree using a subset of the spelling array (from
   * item_star to item_end)
   * @param {DictDef.LmaNodeLE0 | DictDef.LmaNodeGE1} parent
   *    The parent node to update the necessary information.
   * @param {Array.<LemmaEntry>} lemma_arr The lemma array.
   * @param {number} item_start The start position of the lemma array.
   * @param {number} item_end The stop position of the lemma arry.
   * @param {number} level The tree level.
   */
  construct_subset: function dictBuilder_construct_subset(parent, lemma_arr,
                        item_start, item_end, level) {
    if (level >= DictDef.kMaxLemmaSize || item_end <= item_start) {
      return false;
    }

    // 1. Scan for how many sons
    var parent_son_num = 0;

    var lma_last_start = item_start;
    var spl_idx_node = lemma_arr[lma_last_start].spl_idx_arr[level];

    // Scan for how many sons to be allocaed
    for (var i = item_start + 1; i < item_end; i++) {
      var lma_current = lemma_arr[i];
      var spl_idx_current = lma_current.spl_idx_arr[level];
      if (spl_idx_current != spl_idx_node) {
        parent_son_num++;
        spl_idx_node = spl_idx_current;
      }
    }
    parent_son_num++;

    // Use to indicate whether all nodes of this layer have no son.
    var allson_noson = true;

    assert(level < DictDef.kMaxLemmaSize,
           'construct_subset assertion error.' + 'Invliad level: ' + level);
    if (parent_son_num > this.max_sonbuf_len_[level]) {
      this.max_sonbuf_len_[level] = parent_son_num;
    }

    this.total_son_num_[level] += parent_son_num;
    this.total_sonbuf_num_[level] += 1;

    if (parent_son_num == 1) {
      this.sonbufs_num1_++;
    } else {
      this.sonbufs_numgt1_++;
    }
    this.total_lma_node_num_ += parent_son_num;

    // 2. Update the parent's information
    //    Update the parent's son list;
    var son_1st_le0 = 0;  // only one of le0 or ge1 is used
    var son_1st_ge1 = 0;  // only one of le0 or ge1 is used.
    if (0 == level) {
      // the parent is root and of type DictDef.LmaNodeLE0
      parent.son_1st_off =
        this.lma_nds_used_num_le0_;
      son_1st_le0 = this.lma_nds_used_num_le0_;
      this.lma_nds_used_num_le0_ += parent_son_num;

      assert(parent_son_num <= 65535);
      parent.num_of_son = parent_son_num;
    } else if (1 == level) {
      // the parent is a son of root and of type DictDef.LmaNodeLE0
      parent.son_1st_off =
        this.lma_nds_used_num_ge1_;
      son_1st_ge1 = this.lma_nds_used_num_ge1_;
      this.lma_nds_used_num_ge1_ += parent_son_num;

      assert(parent_son_num <= 65535);
      parent.num_of_son = parent_son_num;
    } else {
      // The parent of type DictDef.LmaNodeGE1
      this.set_son_offset(parent, this.lma_nds_used_num_ge1_);
      son_1st_ge1 = this.lma_nds_used_num_ge1_;
      this.lma_nds_used_num_ge1_ += parent_son_num;

      assert(parent_son_num <= 255);
      parent.num_of_son = parent_son_num;
    }

    // 3. Now begin to construct the son one by one
    var son_pos = 0;

    lma_last_start = item_start;
    spl_idx_node = lemma_arr[lma_last_start].spl_idx_arr[level];

    var homo_num = 0;
    if (lemma_arr[lma_last_start].spl_idx_arr.length <= level + 1) {
      homo_num = 1;
    }

    var item_start_next = item_start;

    for (var i = item_start + 1; i < item_end; i++) {
      var lma_current = lemma_arr[i];
      var spl_idx_current = lma_current.spl_idx_arr[level];

      if (spl_idx_current == spl_idx_node) {
        if (lma_current.spl_idx_arr.length <= level + 1) {
          homo_num++;
        }
      } else {
        // Construct a node
        var node_cur_le0 = null;  // only one of them is valid
        var node_cur_ge1 = null;
        if (0 == level) {
          node_cur_le0 = this.lma_nodes_le0_[son_1st_le0 + son_pos];
          node_cur_le0.spl_idx = spl_idx_node;
          node_cur_le0.homo_idx_buf_off =
            this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_;
          node_cur_le0.son_1st_off = 0;
          this.homo_idx_num_eq1_ += homo_num;
        } else {
          node_cur_ge1 = this.lma_nodes_ge1_[son_1st_ge1 + son_pos];
          node_cur_ge1.spl_idx = spl_idx_node;

          this.set_homo_id_buf_offset(node_cur_ge1,
              (this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_));
          this.set_son_offset(node_cur_ge1, 0);
          this.homo_idx_num_gt1_ += homo_num;
        }

        if (homo_num > 0) {
          var idx_offset = this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_ -
            homo_num;
          if (0 == level) {
            assert(homo_num <= 65535);
            node_cur_le0.num_of_homo = homo_num;
          } else {
            assert(homo_num <= 255);
            node_cur_ge1.num_of_homo = homo_num;
          }

          for (var homo_pos = 0; homo_pos < homo_num; homo_pos++) {
            this.homo_idx_buf_[homo_pos + idx_offset] =
              lemma_arr[item_start_next + homo_pos].idx_by_hz;
          }

          if (homo_num > this.max_homobuf_len_[level]) {
            this.max_homobuf_len_[level] = homo_num;
          }

          this.total_homo_num_[level] += homo_num;
        }

        if (i - item_start_next > homo_num) {
          var next_parent;
          if (0 == level) {
            next_parent = node_cur_le0;
          } else {
            next_parent = node_cur_ge1;
          }
          this.construct_subset(next_parent, lemma_arr,
                           item_start_next + homo_num, i, level + 1);

          this.total_node_hasson_[level] += 1;
          allson_noson = false;

        }

        // for the next son
        lma_last_start = i;
        spl_idx_node = spl_idx_current;
        item_start_next = i;
        homo_num = 0;
        if (lma_current.spl_idx_arr.length <= level + 1) {
          homo_num = 1;
        }

        son_pos++;
      }
    }

    // 4. The last one to construct
    var node_cur_le0 = null;  // only one of them is valid
    var node_cur_ge1 = null;
    if (0 == level) {
      node_cur_le0 = this.lma_nodes_le0_[son_1st_le0 + son_pos];
      node_cur_le0.spl_idx = spl_idx_node;
      node_cur_le0.homo_idx_buf_off =
        this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_;
      node_cur_le0.son_1st_off = 0;
      this.homo_idx_num_eq1_ += homo_num;
    } else {
      node_cur_ge1 = this.lma_nodes_ge1_[son_1st_ge1 + son_pos];
      node_cur_ge1.spl_idx = spl_idx_node;

      this.set_homo_id_buf_offset(node_cur_ge1,
                             (this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_));
      this.set_son_offset(node_cur_ge1, 0);
      this.homo_idx_num_gt1_ += homo_num;
    }

    if (homo_num > 0) {
      var idx_offset = this.homo_idx_num_eq1_ + this.homo_idx_num_gt1_ -
        homo_num;
      if (0 == level) {
        assert(homo_num <= 65535);
        node_cur_le0.num_of_homo = homo_num;
      } else {
        assert(homo_num <= 255);
        node_cur_ge1.num_of_homo = homo_num;
      }

      for (var homo_pos = 0; homo_pos < homo_num; homo_pos++) {
        this.homo_idx_buf_[idx_offset + homo_pos] =
          lemma_arr[item_start_next + homo_pos].idx_by_hz;
      }

      if (homo_num > this.max_homobuf_len_[level]) {
        this.max_homobuf_len_[level] = homo_num;
      }

      this.total_homo_num_[level] += homo_num;
    }

    if (item_end - item_start_next > homo_num) {
      var next_parent;
      if (0 == level) {
        next_parent = node_cur_le0;
      } else {
        next_parent = node_cur_ge1;
      }
      this.construct_subset(next_parent, lemma_arr,
                       item_start_next + homo_num, item_end, level + 1);

      this.total_node_hasson_[level] += 1;
      allson_noson = false;

    }

    if (allson_noson) {
      this.total_sonbuf_allnoson_[level] += 1;
      this.total_node_in_sonbuf_allnoson_[level] += parent_son_num;
    }

    assert(son_pos + 1 == parent_son_num);
    return true;
  },

  /**
   * Read valid Chinese Hanzis list from the given file content.
   * num is used to return number of chars.
   * @return {string} The sorted valid Hanzis string.
   */
  read_valid_hanzis: function dictBuilder_read_valid_hanzis(validhzs) {
    if (!validhzs) {
      return '';
    }
    return validhzs.split('').sort().join('');
  },

  /**
   * Read a raw dictionary. max_item is the maximum number of items. If there
   * are more items in the ditionary, only the first max_item will be read.
   * @return {number} The number of items successfully read from the file.
   */
  read_raw_dict: function dictBuilder_read_raw_dict(raw, validhzs,
                                                           max_item) {
    if (!raw) return 0;

    // Read the number of lemmas in the file
    var lemma_num = 240000;

    // allocate resource required
    this.alloc_resource(lemma_num);

    // Read the valid Hanzi list.
    var valid_hzs = this.read_valid_hanzis(validhzs);

    // Split raw into lines
    var lines = raw.match(/^.*([\r\n]+|$)/gm);
    var line_num = lines.length;

    lemma_num = 0;

    // Begin parsing the lemma entries
    for (var i = 0; i < line_num; i++) {

      // The tokens of each line are seperated by white spaces.
      var tokens = lines[i].split(/\s+/g);
      var lemma = new DictDef.LemmaEntry();

      // Get the Hanzi string
      var hanzi = tokens[0].trim();
      var lemma_size = hanzi.length;
      if (lemma_size > DictDef.kMaxLemmaSize) {
        debug('Drop the lemma whose size exceeds the limit: ' + hanzi);
        continue;
      }

      lemma.hanzi_str = hanzi;

      // Get the freq
      var freq = parseFloat(tokens[1]);
      lemma.freq = freq;

      if (lemma_size > 1 && freq < 60) {
        debug('Drop ' + hanzi + ' whose freq < 60 and length > 1.');
        continue;
      }

      // Get GBK mark. If no valid Hanzi list available, all items which
      // contains GBK characters will be discarded. Otherwise, all items
      // which contains characters outside of the valid Hanzi list will
      // be discarded.
      var gbk_flag = parseInt(tokens[2]);

      if (!valid_hzs) {
        if (0 != gbk_flag) {
          debug('Drop lemma containing non-gbk characters: ' + hanzi);
          continue;
        }
      } else {
        if (!this.str_in_hanzis_list(valid_hzs, hanzi)) {
          debug('Drop lemma containing invalid characters: ' + hanzi);
          continue;
        }
      }

      // Get spelling String
      if (tokens.length < 3 + lemma_size) {
        debug('Invalid spelling string ' + tokens + ' for ' + hanzi);
        continue;
      }
      var spelling_not_support = false;
      for (var hz_pos = 0; hz_pos < lemma_size;
           hz_pos++) {
        // Get a Pinyin
        var pinyin_str = this.format_spelling_str(tokens[3 + hz_pos].trim());
        lemma.pinyin_str[hz_pos] = pinyin_str;
        // Put the pinyin to the spelling table
        if (!this.spl_table_.put_spelling(pinyin_str, freq)) {
          spelling_not_support = true;
          break;
        }
      }

      if (spelling_not_support) {
        debug('The spelling string of ' + hanzi + ' isn\'t valid: ' + tokens);
        continue;
      }
      this.lemma_arr_[lemma_num] = lemma;
      lemma_num++;
    }

    debug('read succesfully, lemma num: ' + lemma_num);

    return lemma_num;
  },

  // Try to find if a character is in hzs buffer.
  hz_in_hanzis_list: function dictBuilder_hz_in_hanzis_list(hzs, hz) {
    if (!hzs) {
      return false;
    }

    var found = MyStdlib.mybsearchStr(hz, hzs, 0, hzs.length, 1, null);
    if (-1 == found) {
      return false;
    }

    return true;
  },

  // Try to find if all characters in str are in hzs buffer.
  str_in_hanzis_list: function dictBuilder_str_in_hanzis_list(hzs, str) {
    if (!hzs || !str) {
      return false;
    }

    var str_len = str.length;
    for (var pos = 0; pos < str_len; pos++) {
      if (!this.hz_in_hanzis_list(hzs, str.charAt(pos))) {
        return false;
      }
    }
    return true;
  },

  // Get these lemmas with toppest scores.
  get_top_lemmas: function dictBuilder_get_top_lemmas() {
    this.top_lmas_num_ = 0;
    if (null === this.lemma_arr_)
      return;
    var lemma_num = this.lemma_arr_.length;

    for (var pos = 0; pos < lemma_num; pos++) {
      if (0 == this.top_lmas_num_) {
        this.top_lmas_[0] = this.lemma_arr_[pos];
        this.top_lmas_num_ = 1;
        continue;
      }

      if (this.lemma_arr_[pos].freq >
          this.top_lmas_[this.top_lmas_num_ - 1].freq) {
        if (DictDef.kTopScoreLemmaNum > this.top_lmas_num_) {
          this.top_lmas_num_ += 1;
        }

        var move_pos;
        for (move_pos = this.top_lmas_num_ - 1; move_pos > 0; move_pos--) {
          this.top_lmas_[move_pos] = this.top_lmas_[move_pos - 1];
          if (0 == move_pos - 1 ||
              (move_pos - 1 > 0 &&
               this.top_lmas_[move_pos - 2].freq > this.lemma_arr_[pos].freq)) {
            break;
          }
        }
        assert(move_pos > 0,
               'get_top_lemmas assert error. move_pos:' + move_pos);
        this.top_lmas_[move_pos - 1] = this.lemma_arr_[pos];
      } else if (DictDef.kTopScoreLemmaNum > this.top_lmas_num_) {
        this.top_lmas_[this.top_lmas_num_] = this.lemma_arr_[pos];
        this.top_lmas_num_ += 1;
      }
    }

    debug('\n------Top Lemmas------------------\n');
    for (var pos = 0; pos < this.top_lmas_num_; pos++) {
      debug(StringUtils.format('--{0}, idx:{1}, score:{2}', pos,
                               this.top_lmas_[pos].idx_by_hz,
                               this.top_lmas_[pos].freq));
    }
  },

  /**
   * Allocate resource to build dictionary.
   * lma_num is the number of items to be loaded.
   */
  alloc_resource: function dictBuilder_alloc_resource(lma_num) {
    if (0 == lma_num)
      return;

    var lemma_num = lma_num;
    this.lemma_arr_ = [];

    this.top_lmas_num_ = 0;
    this.top_lmas_ = [];
    for (var i = 0; i < DictDef.kTopScoreLemmaNum; i++) {
      this.top_lmas_[i] = new DictDef.LemmaEntry();
    }

    this.scis_ = [];

    // The root and first level nodes is less than DictDef.kMaxSpellingNum + 1
    this.lma_nds_used_num_le0_ = 0;
    this.lma_nodes_le0_ = [];
    for (var i = 0; i < DictDef.kMaxSpellingNum; i++) {
      this.lma_nodes_le0_[i] = new DictDef.LmaNodeLE0();
    }

    // Other nodes is less than lemma_num
    this.lma_nds_used_num_ge1_ = 0;
    this.lma_nodes_ge1_ = [];
    for (var i = 0; i < lemma_num; i++) {
      this.lma_nodes_ge1_[i] = new DictDef.LmaNodeGE1();
    }

    this.homo_idx_buf_ = [];
    this.spl_table_ = new SpellingTable();
    this.spl_parser_ = new SpellingParser();
    this.spl_table_.init_table(DictDef.kMaxPinyinSize,
                               DictDef.kSplTableHashLen, true);
  }
};

var UserDict = function userDict_constructor() {
};

UserDict.prototype = {
  __proto__: IAtomDictBase
};

var DictList = function dictList_constructor() {
  this.start_pos_ = [];
  this.start_id_ = [];
  this.scis_splid_ = [];
};

DictList.prototype = {
  /* ==== Public ==== */
  save_list: function dictList_save(fp) {
    return false;
  },

  load_list: function dictList_load(fp) {
    return false;
  },

  /**
   * Init the list from the DictDef.LemmaEntry array.
   * @param {Array.<DictDef.SingleCharItem>} scis All single char items.
   * @param {Array.<DictDef.LemmaEntry>} lemma_arr The lemma array. It should
   *    have been sorted by the hanzi_str, and have been given ids from 1.
   */
  init_list: function dictList_init_list(scis, lemma_arr) {
    if (!scis || !lemma_arr)
      return false;

    this.initialized_ = false;

    this.buf_ = [];

    // calculate the size
    var buf_size = this.calculate_size(lemma_arr);
    if (0 == buf_size)
      return false;

    this.fill_scis(scis);

    // Copy the related content from the array to inner buffer
    this.fill_list(lemma_arr);

    this.initialized_ = true;
    return true;
  },

  /**
   * Get the hanzi string for the given id
   * @return {string} The hanzi string if successes. Otherwize empty string.
   */
  get_lemma_str: function dictList_get_lemma_str(id_lemma) {
    if (!this.initialized_ ||
        id_lemma >= this.start_id_[DictDef.kMaxLemmaSize]) {
      return '';
    }

    // Find the range
    for (var i = 0; i < DictDef.kMaxLemmaSize; i++) {
      if (this.start_id_[i] <= id_lemma && this.start_id_[i + 1] > id_lemma) {
        var id_span = id_lemma - this.start_id_[i];
        var pos = this.start_pos_[i] + id_span * (i + 1);
        return this.buf_.substring(pos, pos + i + 1);
      }
    }
    return '';
  },

  /**
   * @param {string} last_hzs stores the last n Chinese characters history,
   * its length should be less or equal than DictDef.kMaxPredictSize.
   * @param {Array.<NPredictItem>} npre_items is used to store the result.
   * @param {number} used specifies how many items have been used from the
   * beiginning of npre_items.
   * @return {number} The number of newly added items.
   */
  predict: function dictList_predict(last_hzs, npre_items, used) {
    // 1. Prepare work
    var hzs_len = last_hzs.length;
    var npre_max = npre_items.length;
    var cmp_func = this.cmp_func_[hzs_len - 1];

    var ngram = NGram.get_instance();

    var item_num = used;

    // 2. Do prediction
    for (var pre_len = 1; pre_len <= DictDef.kMaxPredictSize + 1 - hzs_len;
         pre_len++) {
      var word_len = hzs_len + pre_len;
      var w_buf = this.find_pos_startedbyhzs(last_hzs, cmp_func);
      if (-1 == w_buf)
        continue;
      while (w_buf < this.start_pos_[word_len] &&
             cmp_func(this.buf_[w_buf], last_hzs) == 0 &&
             item_num < npre_max) {
        npre_items[item_num] = new SearchUtility.NPredictItem();
        npre_items[item_num].pre_hzs =
          this.buf_.substring(w_buf + hzs_len, w_buf + hzs_len + pre_len);
        npre_items[item_num].psb =
          ngram.get_uni_psb((w_buf - this.start_pos_[word_len - 1]) /
          word_len + this.start_id_[word_len - 1]);
        npre_items[item_num].his_len = hzs_len;
        item_num++;
        w_buf += word_len;
      }
    }

    var new_num = used;
    for (var i = used; i < item_num; i++) {
      // Try to find it in the existing items
      var e_pos;
      for (e_pos = 0; e_pos < used; e_pos++) {
        if (npre_items[e_pos].pre_hzs == npre_items[i].pre_hzs) {
          break;
        }
      }
      if (e_pos < used)
        continue;

      // If not found, append it to the buffer
      npre_items[new_num] = npre_items[i];
      new_num++;
    }
    return new_num;
  },

  /**
   * If half_splid is a valid half spelling id, return those full spelling
   * ids which share this half id.
   */
  get_splids_for_hanzi:
      function dictList_get_splids_for_hanzi(hanzi, half_splid) {
    var hz_found = MyStdlib.mybsearchStr(hanzi, this.scis_hz_, 0,
                                         his.scis_num_, 1, cmp_hanzis_1);
    var splids = [];

    // Move to the first one.
    while (hz_found > 0 && hanzi == this.scis_hz_[hz_found - 1]) {
      hz_found--;
    }

    // First try to found if strict comparison result is not zero.
    var hz_f = hz_found;
    var strict = false;
    while (hz_f < this.scis_hz_ + this.scis_num_ &&
           hanzi == this.scis_hz_[hz_f]) {
      var pos = hz_f;
      if (0 == half_splid || this.scis_splid_[pos].half_splid == half_splid) {
        strict = true;
      }
      hz_f++;
    }

    var found_num = 0;
    while (hz_found < this.scis_hz_ + this.scis_num_ &&
           hanzi == this.scis_hz_[hz_found]) {
      var pos = hz_found;
      if (0 == half_splid ||
          (strict && this.scis_splid_[pos].half_splid == half_splid) ||
          (!strict && this.spl_trie_.half_full_compatible(half_splid,
          this.scis_splid_[pos].full_splid))) {
        splids[found_num] = scis_splid_[pos].full_splid;
        found_num++;
      }
      hz_found++;
    }

    return splids;
  },

  get_lemma_id: function dictList_get_lemma_id(str) {
    if (!str) {
      return 0;
    }
    var str_len = str.length;
    if (str_len > DictDef.kMaxLemmaSize) {
      return 0;
    }

    var found = this.find_pos_startedbyhzs(str, this.cmp_func_[str_len - 1]);
    if (-1 == found)
      return 0;

    return start_id_[str_len - 1] +
         (found - this.start_pos_[str_len - 1]) / str_len;
  },

  /* ==== Private ==== */
  initialized_: false,
  spl_trie_: null,

  // Number of SingCharItem. The first is blank, because id 0 is invalid.
  scis_num_: 0,

  scis_hz_: '',

  scis_splid_: null,

  // The large memory block to store the word list.
  buf_: '',

  /**
   * Starting position of those words whose lengths are i+1, counted in char16.
   * @type Array.<number>
   */
  start_pos_: null,

  /**
   * @type Array.<number>
   */
  start_id_: null,

  cmp_func_: null,

  /**
   * Calculate the requsted memory, including the start_pos[] buffer.
   * @param {Array.<DictDef.LemmaEntry>} lemma_arr The lemma array.
   */
  calculate_size: function dictList_calculate_size(lemma_arr) {
    var last_hz_len = 0;
    var list_size = 0;
    var id_num = 0;
    var lemma_num = lemma_arr.length;

    for (var i = 0; i < lemma_num; i++) {
      if (0 == i) {
        last_hz_len = lemma_arr[i].hz_str_len;

        id_num++;
        this.start_pos_[0] = 0;
        this.start_id_[0] = id_num;

        last_hz_len = 1;
        list_size += last_hz_len;
      } else {
        var current_hz_len = lemma_arr[i].hz_str_len;

        if (current_hz_len == last_hz_len) {
            list_size += current_hz_len;
            id_num++;
        } else {
          for (var len = last_hz_len; len < current_hz_len - 1; len++) {
            this.start_pos_[len] = start_pos_[len - 1];
            this.start_id_[len] = start_id_[len - 1];
          }

          this.start_pos_[current_hz_len - 1] = list_size;

          id_num++;
          this.start_id_[current_hz_len - 1] = id_num;

          last_hz_len = current_hz_len;
          list_size += current_hz_len;
        }
      }
    }

    for (var i = last_hz_len; i <= DictDef.kMaxLemmaSize; i++) {
      if (0 == i) {
        this.start_pos_[0] = 0;
        this.start_id_[0] = 1;
      } else {
        this.start_pos_[i] = list_size;
        this.start_id_[i] = id_num;
      }
    }

    return this.start_pos_[DictDef.kMaxLemmaSize];
  },

  fill_scis: function dictList_fill_scis(scis) {
    this.scis_hz_ = '';
    for (var pos = 0; pos < this.scis_num_; pos++) {
      this.scis_hz_ += scis[pos].hz;
      this.scis_splid_[pos] = scis[pos].splid;
    }
  },

  // Copy the related content to the inner buffer
  // It should be called after calculate_size()
  fill_list: function dictList_fill_list(lemma_arr) {
    var lemma_num = lemma_arr.length;
    this.buf_ = '';
    for (var i = 0; i < lemma_num; i++) {
      this.buf_ += lemma_arr[i].hanzi_str;
    }
  },

  /**
   * Find the starting position for those words whose lengths are
   * the same with last_hzs and have the same prefix. The given parameter
   * cmp_func decides how many characters from beginning will be used to
   * compare.
   */
  find_pos_startedbyhzs:
      function dictList_find_pos_startedbyhzs(last_hzs, cmp_func) {
    var word_len = last_hzs.length;
    var found_w = MyStdlib.mybsearchStr(last_hzs, this.buf_,
      this.start_pos_[word_len - 1],
      (this.start_pos_[word_len] - this.start_pos_[word_len - 1]) / word_len,
      word_len, cmp_func);

    if (-1 == found_w)
      return -1;

    while (found_w > this.start_pos_[word_len - 1] &&
           cmp_func(this.buf_[found_w], this.buf_[found_w - word_len]) == 0) {
      found_w -= word_len;
    }

    return found_w;
  }
};

/***
 * @private
 */
var NGram = function ngram_constructor() {
  this.freq_codes_df_ = [];
  this.freq_codes_ = [];
  this.lma_freq_idx_ = [];
};

/**
 * @return {NGram} The NGram instance.
 */
NGram.get_instance = function ngram_get_instance() {
  if (NGram.instance_ == null) {
    NGram.instance_ = new NGram();
  }
  return NGram.instance_;
};

NGram.instance_ = null;

/**
 * Convert a probability to score. Actually, the score will be limited to
 * kMaxScore, but at runtime, we also need float expression to get accurate
 * value of the score.
 * After the conversion, a lower score indicates a higher probability of the
 * item.
 */
NGram.convert_psb_to_score = function ngram_convert_psb_to_score(psb) {
  var score = Math.log(psb) * NGram.kLogValueAmplifier;
  if (score > NGram.kMaxScore) {
    score = NGram.kMaxScore;
  }
  return score;
};

NGram.kCodeBookSize = 256;

// The maximum score of a lemma item.
NGram.kMaxScore = 0x3fff;

/**
 * In order to reduce the storage size, the original log value is amplified by
 * kScoreAmplifier, and we use LmaScoreType to store.
 * After this process, an item with a lower score has a higher frequency.
 */
NGram.kLogValueAmplifier = -800;

/** System words' total frequency. It is not the real total frequency, instead,
 * It is only used to adjust system lemmas' scores when the user dictionary's
 * total frequency changes.
 * In this version, frequencies of system lemmas are fixed. We are considering
 * to make them changable in next version.
 */
NGram.kSysDictTotalFreq = 100000000;

NGram.prototype = {
  /* ==== Public ==== */
  save_ngram: function ngram_save_ngram(fp) {
    return false;
  },

  load_ngram: function ngram_load_ngram(fp) {
    return false;
  },

  // Set the total frequency of all none system dictionaries.
  set_total_freq_none_sys:
      function ngram_set_total_freq_none_sys(freq_none_sys) {
    this.total_freq_none_sys_ = freq_none_sys;
    if (0 == this.total_freq_none_sys_) {
      this.sys_score_compensation_ = 0;
    } else {
      var factor = NGram.kSysDictTotalFreq / (NGram.kSysDictTotalFreq +
        this.total_freq_none_sys_);
      this.sys_score_compensation_ = Math.log(factor) *
        NGram.kLogValueAmplifier;
    }
  },

  get_uni_psb: function ngram_get_uni_psb(lma_id) {
    return this.freq_codes_[this.lma_freq_idx_[lma_id]] +
      this.sys_score_compensation_;
  },

  /**
   * For constructing the unigram mode model.
   * @param {Array.<DictDef.LemmaEntry>} lemma_arr Lemma array.
   */
  build_unigram: function ngram_build_unigram(lemma_arr) {
    debug('build_unigram');
    if (!lemma_arr) {
      return false;
    }

    var lemma_num = lemma_arr.length;
    if (lemma_num == 0) {
      return false;
    }

    var total_freq = 0;
    var freqs = [];

    freqs[0] = 0.3;
    total_freq += freqs[0];
    var idx_now = 0;
    for (var pos = 0; pos < lemma_num; pos++) {
      if (lemma_arr[pos].idx_by_hz == idx_now)
        continue;
      idx_now++;

      freqs[idx_now] = lemma_arr[pos].freq;
      if (freqs[idx_now] <= 0) {
        freqs[idx_now] = 0.3;
      }

      total_freq += freqs[idx_now];
    }

    var max_freq = 0;
    this.idx_num_ = idx_now + 1;

    for (var pos = 0; pos < this.idx_num_; pos++) {
      freqs[pos] = freqs[pos] / total_freq;
      if (freqs[pos] > max_freq) {
        max_freq = freqs[pos];
      }
    }

    // calculate the code book
    this.freq_codes_df_ = [];
    this.freq_codes_ = [];
    for (var pos = 0; pos < NGram.kCodeBookSize; pos++) {
      this.freq_codes_df_[pos] = 0;
      this.freq_codes_[pos] = 0;
    }

    var freq_pos = 0;
    for (var code_pos = 0; code_pos < NGram.kCodeBookSize; code_pos++) {
      var found = true;
      while (found) {
        found = false;
        assert(freq_pos < freqs.length, 'build_unigram assertion error.' +
               'Not enough data to create code book.');
        var cand = freqs[freq_pos];
        for (var i = 0; i < code_pos; i++) {
          if (this.freq_codes_df_[i] == cand) {
            found = true;
            break;
          }
        }
        if (found) {
          freq_pos++;
        }
      }

      this.freq_codes_df_[code_pos] = freqs[freq_pos];
      freq_pos++;
    }

    this.freq_codes_df_.sort(SearchUtility.compare);

    this.lma_freq_idx_ = [];
    for (var pos = 0; pos < this.idx_num_; pos++) {
      this.lma_freq_idx_[pos] = 0;
    }

    this.iterate_codes(freqs, this.freq_codes_df_,
                       this.lma_freq_idx_);

    for (var code_pos = 0; code_pos < NGram.kCodeBookSize; code_pos++) {
      var log_score = Math.log(this.freq_codes_df_[code_pos]);
      var final_score =
        NGram.convert_psb_to_score(this.freq_codes_df_[code_pos]);
      this.freq_codes_[code_pos] = final_score;
    }

    this.initialized_ = true;
    return true;
  },

  /* ==== Private ==== */
  initialized_: false,

  idx_num_: 0,

  total_freq_none_sys_: 0,

  // Score compensation for system dictionary lemmas.
  // Because after user adds some user lemmas, the total frequency changes, and
  // we use this value to normalize the score.
  sys_score_compensation_: 0,

  freq_codes_df_: null,

  freq_codes_: null,

  lma_freq_idx_: null,

  iterate_codes: function ngram_iterate_codes(freqs, code_book, code_idx) {
    var iter_num = 0;
    var delta_last = 0;
    do {
      var changed = this.update_code_idx(freqs, code_book, code_idx);

      var delta = this.recalculate_kernel(freqs, code_book, code_idx);

      iter_num++;

      if (iter_num > 1 &&
          (delta == 0 ||
          Math.abs(delta_last - delta) / Math.abs(delta) < 0.000000001)) {
        break;
      }
      delta_last = delta;
    } while (true);
  },

  update_code_idx: function ngram_update_code_idx(freqs, code_book, code_idx) {
    var num = freqs.length;
    var changed = 0;
    for (var pos = 0; pos < num; pos++) {
      var idx = this.qsearch_nearest(code_book, freqs[pos], 0,
                                 NGram.kCodeBookSize - 1);
      if (idx != code_idx[pos]) {
        changed++;
      }
      code_idx[pos] = idx;
    }
    return changed;
  },

  // Find the index of the code value which is nearest to the given freq
  qsearch_nearest:
      function ngram_qsearch_nearest(code_book, freq, start, end) {
    if (start == end) {
      return start;
    }

    if (start + 1 == end) {
      if (this.distance(freq, code_book[end]) >
          this.distance(freq, code_book[start])) {
        return start;
      }
      return end;
    }

    var mid = Math.floor((start + end) / 2);

    if (code_book[mid] > freq) {
      return this.qsearch_nearest(code_book, freq, start, mid);
    } else {
      return this.qsearch_nearest(code_book, freq, mid, end);
    }
  },

  distance: function ngram_distance(freq, code) {
    return freq * Math.abs(Math.log(freq) - Math.log(code));
  },

  recalculate_kernel:
      function ngram_recalculate_kernel(freqs, code_book, code_idx) {
    var num = freqs.length;
    var ret = 0;

    var item_num = [];
    var cb_new = [];
    for (var pos = 0; pos < NGram.kCodeBookSize; pos++) {
      item_num[pos] = 0;
      cb_new[pos] = 0;
    }

    for (var pos = 0; pos < num; pos++) {
      ret += this.distance(freqs[pos], code_book[code_idx[pos]]);

      cb_new[code_idx[pos]] += freqs[pos];
      item_num[code_idx[pos]] += 1;
    }

    for (var code = 0; code < NGram.kCodeBookSize; code++) {
      code_book[code] = cb_new[code] / item_num[code];
    }

    return ret;
  }
};

var SpellingParser = function spellingParser_constructor() {
  this.spl_trie_ = SpellingTrie.get_instance();
};


SpellingParser.prototype = {
  /* ==== Private ==== */

  /**
   * @type SpellingTrie
   */
  spl_trie_: null,

  /* ==== Public ==== */

  /** Given a string, parse it into a spelling id stream.
   * @param {string} splstr The given spelling string.
   * @return
   * {spl_idx: Array.<number>, start_pos: Array.<number>, last_is_pre: boolean}
   * If the whole string are successfully parsed, last_is_pre will be true;
   * if the whole string is not fully parsed, last_is_pre will return whether
   * the last part of the string is a prefix of a full spelling string. For
   * example, given string "zhengzhon", "zhon" is not a valid spelling, but it
   * is the prefix of "zhong".
   * If splstr starts with a character not in ['a'-z'] (it is a split char),
   * return empty result.
   * Split char can only appear in the middle of the string or at the end.
   */
  splstr_to_idxs: function spellingParser_splstr_to_idxs(splstr) {
    var defaultResult = {spl_idx: [], start_pos: [], last_is_pre: false};
    if (!splstr) {
      return defaultResult;
    }

    if (!SpellingTrie.is_valid_spl_char(splstr[0])) {
      return defaultResult;
    }

    var last_is_pre = false;

    var node_this = this.spl_trie_.root_;

    var str_pos = 0;
    var idx_num = 0;
    var spl_idx = [];
    var start_pos = [0];
    var last_is_splitter = false;
    var str_len = splstr.length;
    while (str_pos < str_len) {
      var char_this = splstr[str_pos];
      // all characters outside of [a, z] are considered as splitters
      if (!SpellingTrie.is_valid_spl_char(char_this)) {
        // test if the current node is endable
        var id_this = node_this.spelling_idx;
        var ret = this.spl_trie_.if_valid_id_update(id_this);
        if (ret.valid) {
          id_this = ret.spl_id;
          spl_idx[idx_num] = id_this;

          idx_num++;
          str_pos++;
          start_pos[idx_num] = str_pos;

          node_this = this.spl_trie_.root_;
          last_is_splitter = true;
          continue;
        } else {
          if (last_is_splitter) {
            str_pos++;
            start_pos[idx_num] = str_pos;
            continue;
          } else {
            return {
              spl_idx: spl_idx,
              start_pos: start_pos,
              last_is_pre: last_is_pre
            };
          }
        }
      }

      last_is_splitter = false;

      var found_son = null;

      if (0 == str_pos) {
        if (char_this >= 'a') {
          found_son =
            this.spl_trie_.level1_sons_[StringUtils.charDiff(char_this, 'a')];
        } else {
          found_son =
            this.spl_trie_.level1_sons_[StringUtils.charDiff(char_this, 'A')];
        }
      } else {
        var sons = node_this.sons;
        // Because for Zh/Ch/Sh nodes, they are the last in the buffer and
        // frequently used, so we scan from the end.
        for (var i = 0; i < node_this.num_of_son; i++) {
          var this_son = sons[i];
          if (SpellingTrie.is_same_spl_char(
              this_son.char_this_node, char_this)) {
            found_son = this_son;
            break;
          }
        }
      }

      // found, just move the current node pointer to the the son
      if (null != found_son) {
        node_this = found_son;
      } else {
        // not found, test if it is endable
        var id_this = node_this.spelling_idx;
        var ret = this.spl_trie_.if_valid_id_update(id_this);
        if (ret.valid) {
          id_this = ret.spl_id;
          // endable, remember the index
          spl_idx[idx_num] = id_this;

          idx_num++;
          start_pos[idx_num] = str_pos;
          node_this = this.spl_trie_.root_;
          continue;
        } else {
          return {
            spl_idx: spl_idx,
            start_pos: start_pos,
            last_is_pre: last_is_pre
          };
        }
      }

      str_pos++;
    }

    var id_this = node_this.spelling_idx;
    var ret = this.spl_trie_.if_valid_id_update(id_this);
    if (ret.valid) {
      id_this = ret.spl_id;
      // endable, remember the index
      spl_idx[idx_num] = id_this;

      idx_num++;
      start_pos[idx_num] = str_pos;
    }

    last_is_pre = !last_is_splitter;

    return {spl_idx: spl_idx, start_pos: start_pos, last_is_pre: last_is_pre};
  },

  /**
   * Similar to splstr_to_idxs(), the only difference is that splstr_to_idxs()
   * convert single-character Yunmus into half ids, while this function converts
   * them into full ids.
   */
  splstr_to_idxs_f: function spellingParser_splstr_to_idxs_f(splstr) {
    var ret = this.splstr_to_idxs(splstr);
    var spl_idx = ret.spl_idx;
    var idx_num = spl_idx.length;

    for (var pos = 0; pos < idx_num; pos++) {
      if (this.spl_trie_.is_half_id_yunmu(spl_idx[pos])) {
        var full = this.spl_trie_.half_to_full(spl_idx[pos]);
        if (full.num > 0) {
          spl_idx[pos] = full.spl_id_start;
        }
        if (pos == idx_num - 1) {
          ret.last_is_pre = false;
        }
      }
    }
    return ret;
  },

  /**
   * Get the spelling id of given string.
   * @param {String} splstr The spelling string.
   * @return {spl_id: Integer, is_pre: Boolean}
   * If the given string is a spelling, return the id, others, return 0.
   * If the give string is a single char Yunmus like "A", and the char is
   * enabled in ShouZiMu mode, the returned spelling id will be a half id.
   * When the returned spelling id is a half id, is_pre returns whether it
   * is a prefix of a full spelling string.
   */
  get_spl_id_by_str: function spellingParser_get_spl_id_by_str(splstr) {
    var spl_idx = [];
    var start_pos = [];

    var ret = this.splstr_to_idxs(splstr);
    if (ret.spl_idx.length != 1) {
      return {spl_id: 0, is_pre: false};
    }

    if (ret.start_pos[1] != splstr.length) {
      return {spl_id: 0, is_pre: false};
    }
    return {spl_id: ret.spl_idx[0], is_pre: ret.last_is_pre};
  },

  /**
   * Splitter chars are not included.
   */
  is_valid_to_parse: function spellingParser_is_valid_to_parse(ch) {
    return SpellingTrie.is_valid_spl_char(ch);
  }
};

// Node used for the trie of spellings
var SpellingNode = function spellingNode_constructor() {
  this.sons = [];
};

SpellingNode.prototype = {
  /**
   * @type Array.<SpellingNode>
   */
  sons: null,
  /**
   * The spelling id for each node.
   * @type Integer
   */
  spelling_idx: 0,
  /**
   * @type number
   */
  num_of_son: 0,

  /**
   * @type string
   */
  char_this_node: '',

  /**
   * @type number
   */
  score: 0
};

var SpellingTrie = function spellingTrie_constructor() {
  this.h2f_start_ = [];
  this.szm_enable_shm(true);
  this.szm_enable_ym(true);
};

SpellingTrie.instance_ = null;

SpellingTrie.get_instance = function get_instance() {
  if (SpellingTrie.instance_ == null) {
    SpellingTrie.instance_ = new SpellingTrie();
  }
  return SpellingTrie.instance_;
};

SpellingTrie.kFullspl_idStart = kHalfSpellingIdNum + 1;
SpellingTrie.kMaxYmNum = 64;
SpellingTrie.kValidSplCharNum = 26;
SpellingTrie.kHalfIdShengmuMask = 0x01;
SpellingTrie.kHalfIdYunmuMask = 0x02;
SpellingTrie.kHalfIdSzmMask = 0x04;

/**
 * Map from half spelling id to single char.
 * For half ids of Zh/Ch/Sh, map to z/c/s (low case) respectively.
 * For example, 1 to 'A', 2 to 'B', 3 to 'C', 4 to 'c', 5 to 'D', ...,
 * 28 to 'Z', 29 to 'z'.
 * [0] is not used to achieve better efficiency.
 */
SpellingTrie.kHalfId2Sc_ = '0ABCcDEFGHIJKLMNOPQRSsTUVWXYZz';

/**
 * Bit 0 : is it a Shengmu char?
 * Bit 1 : is it a Yunmu char? (one char is a Yunmu)
 * Bit 2 : is it enabled in ShouZiMu(first char) mode?
 */
SpellingTrie.char_flags_ = [
  // a    b      c     d     e     f     g
  0x02, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01,
  // h    i     j      k     l     m    n
  0x01, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01,
  // o    p     q      r     s     t
  0x02, 0x01, 0x01, 0x01, 0x01, 0x01,
  // u    v     w      x     y     z
  0x00, 0x00, 0x01, 0x01, 0x01, 0x01
];

SpellingTrie.is_valid_spl_char = function is_valid_spl_char(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
};

// The caller guarantees that the two chars are valid spelling chars.
SpellingTrie.is_same_spl_char = function is_same_spl_char(ch1, ch2) {
  return ch1.toUpperCase() == ch2.toUpperCase();
};

SpellingTrie.prototype = {
 /* ==== Public ==== */

  /**
   * Construct the tree from the input pinyin array
   * The given string list should have been sorted.
   * @param {String[]} spelling_arr The input pinyin array.
   * @param {number} score_amplifier is used to convert a possibility
   * value into score.
   * @param {number} average_score is the average_score of all spellings.
   * The dumb node is assigned with this score.
   */
  construct: function spellingTrie_construct(spelling_arr, score_amplifier,
                                             average_score) {
    if (!spelling_arr)
      return false;

    this.h2f_start_ = [];
    this.h2f_num_ = [];

    this.spelling_buf_ = spelling_arr.concat();
    this.spelling_num_ = spelling_arr.length;

    this.score_amplifier_ = score_amplifier;
    this.average_score_ = average_score;

    this.splstr_queried_ = '';

    this.node_num_ = 1;

    this.root_ = new SpellingNode();

    this.level1_sons_ = [];

    this.root_.sons =
      this.construct_spellings_subset(0, this.spelling_num_, 0, this.root_);

    // Root's score should be cleared.
    this.root_.score = 0;

    if (this.root_.sons.length == 0)
      return false;

    this.h2f_start_[0] = this.h2f_num_[0] = 0;

    if (!this.build_f2h())
      return false;

    return this.build_ym_info();
  },

  /**
   * Test if the given id is a valid spelling id.
   * @return {valid: Boolean, spl_id: Integer}
   * If valid is true, the given spl_id may be updated like this:
   * When 'A' is not enabled in ShouZiMu mode, the parsing result for 'A' is
   * first given as a half id 1, but because 'A' is a one-char Yunmu and
   * it is a valid id, it needs to updated to its corresponding full id.
   */
  if_valid_id_update: function spellingTrie_if_valid_id_update(spl_id) {
    if (!spl_id)
      return {valid: false, spl_id: spl_id};

    if (spl_id >= SpellingTrie.kFullspl_idStart) {
      return {valid: true, spl_id: spl_id};
    }
    if (spl_id < SpellingTrie.kFullspl_idStart) {
      var ch = SpellingTrie.kHalfId2Sc_[spl_id];
      if (ch > 'Z') {
        // For half ids of Zh/Ch/Sh, map to z/c/s (low case)
        return {valid: true, spl_id: spl_id};
      } else {
        if (this.szm_is_enabled(ch)) {
          return {valid: true, spl_id: spl_id};
        } else if (this.is_yunmu_char(ch)) {
          spl_id = this.h2f_start_[spl_id];
          return {valid: true, spl_id: spl_id};
        }
      }
    }
    return {valid: false, spl_id: spl_id};
  },


  // Test if the given id is a half id.
  is_half_id: function spellingTrie_is_half_id(spl_id) {
    if (0 == spl_id || spl_id >= SpellingTrie.kFullspl_idStart)
      return false;

    return true;
  },

  is_full_id: function spellingTrie_is_full_id(spl_id) {
    if (spl_id < SpellingTrie.kFullspl_idStart ||
        spl_id >= SpellingTrie.kFullspl_idStart + this.spelling_num_)
      return false;
    return true;
  },

  // Test if the given id is a one-char Yunmu id (obviously, it is also a half
  // id), such as 'A', 'E' and 'O'.
  is_half_id_yunmu: function spellingTrie_is_half_id_yunmu(spl_id) {
    if (0 == spl_id || spl_id >= SpellingTrie.kFullspl_idStart)
      return false;

    var ch = SpellingTrie.kHalfId2Sc_[spl_id];
    // If ch >= 'a', that means the half id is one of Zh/Ch/Sh
    if (ch >= 'a') {
      return false;
    }

    return SpellingTrie.char_flags_[StringUtils.charDiff(ch, 'A')] &
      SpellingTrie.kHalfIdYunmuMask;
  },

  /** Test if this char is a ShouZiMu char. This ShouZiMu char may be not
   * enabled.
   * For Pinyin, only i/u/v is not a ShouZiMu char.
   * The caller should guarantee that ch >= 'A' && ch <= 'Z'
   */
  is_szm_char: function spellingTrie_is_szm_char(ch) {
    return this.is_shengmu_char(ch) || this.is_yunmu_char(ch);
  },

  // Test If this char is enabled in ShouZiMu mode.
  // The caller should guarantee that ch >= 'A' && ch <= 'Z'
  szm_is_enabled: function spellingTrie_szm_is_enabled(ch) {
    return SpellingTrie.char_flags_[StringUtils.charDiff(ch, 'A')] &
      SpellingTrie.kHalfIdSzmMask;
  },

  // Enable/disable Shengmus in ShouZiMu mode(using the first char of a spelling
  // to input).
  szm_enable_shm: function spellingTrie_szm_enable_shm(enable) {
    if (enable) {
      for (var code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        var ch = String.fromCharCode(code);
        if (this.is_shengmu_char(ch)) {
          SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] =
            SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] |
            SpellingTrie.kHalfIdSzmMask;
        }
      }
    } else {
      for (var code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        var ch = String.fromCharCode(code);
        if (this.is_shengmu_char(ch)) {
          SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] =
            SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] &
            (SpellingTrie.kHalfIdSzmMask ^ 0xff);
        }
      }
    }
  },

  // Enable/disable Yunmus in ShouZiMu mode.
  szm_enable_ym: function spellingTrie_szm_enable_ym(enable) {
    if (enable) {
      for (var code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        var ch = String.fromCharCode(code);
        if (this.is_yunmu_char(ch)) {
          SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] =
            SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] |
            SpellingTrie.kHalfIdSzmMask;
        }
      }
    } else {
      for (var code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
        var ch = String.fromCharCode(code);
        if (this.is_yunmu_char(ch)) {
          SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] =
            SpellingTrie.char_flags_[code - 'A'.charCodeAt(0)] &
            (SpellingTrie.kHalfIdSzmMask ^ 0xff);
        }
      }
    }
  },

  // Return the number of full ids for the given half id.
  half2full_num: function spellingTrie_half2full_num(half_id) {
    if (null == this.root_ || half_id >= SpellingTrie.kFullspl_idStart)
      return 0;
    return this.h2f_num_[half_id];
  },

  /**
   * @return {num: Integer, spl_id_start: Integer} num is the number of full ids
   * for the given half id, and spl_id_start is the first full id.
   */
  half_to_full: function spellingTrie_half_to_full(half_id) {
    if (null == this.root_ || half_id >= SpellingTrie.kFullspl_idStart) {
      return {num: 0, spl_id_start: 0};
    }

    var spl_id_start = this.h2f_start_[half_id];
    return {num: this.h2f_num_[half_id], spl_id_start: spl_id_start};
  },

  // Return the corresponding half id for the given full id.
  // Not frequently used, low efficient.
  // Return 0 if fails.
  full_to_half: function spellingTrie_full_to_half(full_id) {
    if (null == this.root_ || full_id < SpellingTrie.kFullspl_idStart ||
        full_id > this.spelling_num_ + SpellingTrie.kFullspl_idStart) {
      return 0;
    }

    return this.f2h_[full_id - SpellingTrie.kFullspl_idStart];
  },

  // To test whether a half id is compatible with a full id.
  // Generally, when half_id == full_to_half(full_id), return true.
  // But for "Zh, Ch, Sh", if fussy mode is on, half id for 'Z' is compatible
  // with a full id like "Zhe". (Fussy mode is not ready).
  half_full_compatible: function spellingTrie_half_full_compatible(
      half_id, full_id) {
    var half_fr_full = this.full_to_half(full_id);

    if (half_fr_full == half_id) {
      return true;
    }

    // So that Zh/Ch/Sh(whose char is z/c/s) can be matched with Z/C/S.
    var ch_f = SpellingTrie.kHalfId2Sc_[half_fr_full].toUpperCase();
    var ch_h = SpellingTrie.kHalfId2Sc_[half_id];
    if (ch_f == ch_h) {
      return true;
    }

    return false;
  },

  // Save to the file stream
  save_spl_trie: function spellingTrie_save_spl_trie(fp) {

  },

  // Load from the file stream
  load_spl_trie: function spellingTrie_load_spl_trie(fp) {

  },

  // Get the number of spellings
  get_spelling_num: function spellingTrie_get_spelling_num() {
    return this.spelling_num_;
  },

  // Return the Yunmu id for the given Yunmu string.
  // If the string is not valid, return 0;
  get_ym_id: function spellingTrie_get_ym_id(ym_str) {
    if ('' == ym_str || '' == this.ym_buf_) {
      return 0;
    }

    for (var pos = 0; pos < this.ym_num_; pos++) {
      if (this.ym_buf_[pos] == ym_str) {
        return pos + 1;
      }
    }

    return 0;
  },

  // Get the readonly Pinyin string for a given spelling id
  get_spelling_str: function spellingTrie_get_spelling_str(spl_id) {
    this.splstr_queried_ = '';

    if (spl_id >= SpellingTrie.kFullspl_idStart) {
      spl_id -= SpellingTrie.kFullspl_idStart;
      this.splstr_queried_ = this.spelling_buf_[spl_id].str;
    } else {
      if (spl_id == StringUtils.charDiff('C', 'A') + 1 + 1) {
        this.splstr_queried_ = 'Ch';
      } else if (spl_id == StringUtils.charDiff('S', 'A') + 1 + 2) {
        this.splstr_queried_ = 'Sh';
      } else if (spl_id == StringUtils.charDiff('Z', 'A') + 1 + 3) {
        this.splstr_queried_ = 'Zh';
      } else {
        if (spl_id > StringUtils.charDiff('C', 'A') + 1) {
          spl_id--;
        }
        if (spl_id > StringUtils.charDiff('S', 'A') + 1) {
          spl_id--;
        }
        this.splstr_queried_ =
          String.fromCharCode('A'.charCodeAt(0) + spl_id - 1);
      }
    }
    return this.splstr_queried_;
  },

  /* ==== Private ==== */

  /**
   * The spelling table
   * @type Array.<RawSpelling>
   */
  spelling_buf_: null,

  // Number of full spelling ids.
  spelling_num_: 0,

  score_amplifier_: 0.0,
  average_score_: 0,

  // The Yunmu id list for the spelling ids (for half ids of Shengmu,
  // the Yunmu id is 0).
  // The length of the list is spelling_num_ + kFullspl_idStart,
  // so that spl_ym_ids_[spl_id] is the Yunmu id of the spl_id.
  // @type Integer[]
  spl_ym_ids_: null,

  // The Yunmu table.
  // Each Yunmu will be assigned with Yunmu id from 1.
  ym_buf_: null,
  ym_num_: 0,

  // The spelling string just queried
  splstr_queried_: '',

  // The root node of the spelling tree
  // @type SpellingNode
  root_: null,

  // Used to get the first level sons.
  // @type SpellingNode[SpellingTrie.kValidSplCharNum]
  level1_sons_: null,

  // The full spl_id range for specific half id.
  // h2f means half to full.
  // A half id can be a ShouZiMu id (id to represent the first char of a full
  // spelling, including Shengmu and Yunmu), or id of zh/ch/sh.
  // [1..SpellingTrie.kFullspl_idStart-1] is the range of half id.
  h2f_start_: null,          // @type Integer[SpellingTrie.kFullspl_idStart]
  h2f_num_: null,            // @type Integer[SpellingTrie.kFullspl_idStart]

  /** Map from full id to half id.
   * @type Integer[]
   */
  f2h_: null,

  // How many node used to build the trie.
  node_num_: 0,

  // Construct a subtree using a subset of the spelling array (from
  // item_star to item_end).
  // parent is used to update its num_of_son and score.
  construct_spellings_subset: function spellingTrie_free_son_trie(
      item_start, item_end, level, parent) {
    if (item_end <= item_start || null == parent)
      return null;

    var sons = [];
    var num_of_son = 0;
    var min_son_score = 255;

    var spelling_last_start = this.spelling_buf_[item_start];
    var char_for_node = spelling_last_start.str[level];
    assert(char_for_node >= 'A' && char_for_node <= 'Z' ||
         'h' == char_for_node,
         'construct_spellings_subset assertion error.' +
         'Invalid char_for_node.');

    // Scan the array to find how many sons
    for (var i = item_start + 1; i < item_end; i++) {
      var spelling_current = this.spelling_buf_[i];
      var char_current = spelling_current.str[level];
      if (char_current != char_for_node) {
        num_of_son++;
        char_for_node = char_current;
      }
    }
    num_of_son++;

    this.node_num_ += num_of_son;
    for (var i = 0; i < num_of_son; i++) {
      sons[i] = new SpellingNode();
    }

    // Now begin construct tree
    var son_pos = 0;

    char_for_node = spelling_last_start.str[level];

    var spelling_endable = true;
    if (spelling_last_start.str.length > level + 1) {
      spelling_endable = false;
    }

    var item_start_next = item_start;

    for (var i = item_start + 1; i < item_end; i++) {
      var spelling_current = this.spelling_buf_[i];
      var char_current = spelling_current.str[level];
      assert(SpellingTrie.is_valid_spl_char(char_current),
        'construct_spellings_subset assertion error. Invalid char_current: ' +
        char_current);

      if (char_current != char_for_node) {
        // Construct a node
        var node_current = sons[son_pos];
        node_current.char_this_node = char_for_node;
        if (!char_for_node) {
          assertEq(true, false, 'char_this_node');
        }
        // For quick search in the first level
        if (0 == level) {
          this.level1_sons_[StringUtils.charDiff(char_for_node, 'A')] =
            node_current;
        }

        if (spelling_endable) {
          node_current.spelling_idx =
            SpellingTrie.kFullspl_idStart + item_start_next;
        }

        if (spelling_last_start.str.length > level + 1 ||
            i - item_start_next > 1) {
          var real_start = item_start_next;
          if (spelling_last_start.str.length == level + 1) {
            real_start++;
          }

          node_current.sons =
              this.construct_spellings_subset(real_start, i, level + 1,
                                         node_current);

          if (real_start == item_start_next + 1) {
            var score_this = spelling_last_start.score;
            if (score_this < node_current.score) {
              node_current.score = score_this;
            }
          }
        } else {
          node_current.sons = [];
          node_current.score = spelling_last_start.score;
        }

        if (node_current.score < min_son_score) {
          min_son_score = node_current.score;
        }

        var is_half = false;
        if (level == 0 && this.is_szm_char(char_for_node)) {
          node_current.spelling_idx =
            StringUtils.charDiff(char_for_node, 'A') + 1;
          if (char_for_node > 'C') {
            node_current.spelling_idx++;
          }
          if (char_for_node > 'S') {
            node_current.spelling_idx++;
          }

          this.h2f_num_[node_current.spelling_idx] = i - item_start_next;
          is_half = true;
        } else if (level == 1 && char_for_node == 'h') {
          var ch_level0 = spelling_last_start.str[0];
          var part_id = 0;
          if (ch_level0 == 'C') {
            part_id = StringUtils.charDiff('C', 'A') + 1 + 1;
          }
          else if (ch_level0 == 'S') {
            part_id = StringUtils.charDiff('S', 'A') + 1 + 2;
          }
          else if (ch_level0 == 'Z') {
            part_id = StringUtils.charDiff('Z', 'A') + 1 + 3;
          }
          if (0 != part_id) {
            node_current.spelling_idx = part_id;
            this.h2f_num_[node_current.spelling_idx] = i - item_start_next;
            is_half = true;
          }
        }

        if (is_half) {
          if (this.h2f_num_[node_current.spelling_idx] > 0) {
            this.h2f_start_[node_current.spelling_idx] =
              item_start_next + SpellingTrie.kFullspl_idStart;
          } else {
            this.h2f_start_[node_current.spelling_idx] = 0;
          }
        }

        // for next sibling
        spelling_last_start = spelling_current;
        char_for_node = char_current;
        item_start_next = i;
        spelling_endable = true;
        if (spelling_current.str.length > level + 1) {
          spelling_endable = false;
        }
        son_pos++;
      }
    }

    // the last one
    var node_current = sons[son_pos];
    node_current.char_this_node = char_for_node;
    if (!char_for_node) {
      assertEq(true, false, 'char_this_node' + char_for_node);
    }
    // For quick search in the first level
    if (0 == level) {
      this.level1_sons_[StringUtils.charDiff(char_for_node, 'A')] =
        node_current;
    }

    if (spelling_endable) {
      node_current.spelling_idx =
        SpellingTrie.kFullspl_idStart + item_start_next;
    }

    if (spelling_last_start.str.length > level + 1 ||
        item_end - item_start_next > 1) {
      var real_start = item_start_next;
      if (spelling_last_start.str.length == level + 1) {
        real_start++;
      }

      node_current.sons =
          this.construct_spellings_subset(real_start, item_end, level + 1,
                                     node_current);

      if (real_start == item_start_next + 1) {
        var score_this = spelling_last_start.score;
        if (score_this < node_current.score) {
          node_current.score = score_this;
        }
      }
    } else {
      node_current.sons = [];
      node_current.score = spelling_last_start.score;
    }

    if (node_current.score < min_son_score) {
      min_son_score = node_current.score;
    }

    var is_half = false;
    if (level == 0 && this.szm_is_enabled(char_for_node)) {
      node_current.spelling_idx = StringUtils.charDiff(char_for_node, 'A') + 1;
      if (char_for_node > 'C') {
        node_current.spelling_idx++;
      }
      if (char_for_node > 'S') {
        node_current.spelling_idx++;
      }

      this.h2f_num_[node_current.spelling_idx] = item_end - item_start_next;
      is_half = true;
    } else if (level == 1 && char_for_node == 'h') {
      var ch_level0 = spelling_last_start.str[0];
      var part_id = 0;
      if (ch_level0 == 'C') {
        part_id = StringUtils.charDiff('C', 'A') + 1 + 1;
      }
      else if (ch_level0 == 'S') {
        part_id = StringUtils.charDiff('S', 'A') + 1 + 2;
      }
      else if (ch_level0 == 'Z') {
        part_id = StringUtils.charDiff('Z', 'A') + 1 + 3;
      }
      if (0 != part_id) {
        node_current.spelling_idx = part_id;
        this.h2f_num_[node_current.spelling_idx] = item_end - item_start_next;
        is_half = true;
      }
    }
    if (is_half) {
      if (this.h2f_num_[node_current.spelling_idx] > 0) {
        this.h2f_start_[node_current.spelling_idx] =
          item_start_next + SpellingTrie.kFullspl_idStart;
      } else {
        this.h2f_start_[node_current.spelling_idx] = 0;
      }
    }

    parent.num_of_son = num_of_son;
    parent.score = min_son_score;
    return sons;
  },

  build_f2h: function spellingTrie_build_f2h() {
    this.f2h_ = [];

    for (var hid = 0; hid < SpellingTrie.kFullspl_idStart; hid++) {
      for (var fid = this.h2f_start_[hid];
           fid < this.h2f_start_[hid] + this.h2f_num_[hid]; fid++) {
        this.f2h_[fid - SpellingTrie.kFullspl_idStart] = hid;
      }
    }

    return true;
  },

  // The caller should guarantee ch >= 'A' && ch <= 'Z'
  is_shengmu_char: function spellingTrie_is_shengmu_char(ch) {
    return SpellingTrie.char_flags_[StringUtils.charDiff(ch, 'A')] &
      SpellingTrie.kHalfIdShengmuMask;
  },

  // The caller should guarantee ch >= 'A' && ch <= 'Z'
  is_yunmu_char: function spellingTrie_is_yunmu_char(ch) {
    return SpellingTrie.char_flags_[StringUtils.charDiff(ch, 'A')] &
      SpellingTrie.kHalfIdYunmuMask;
  },

  // Given a spelling string, return its Yunmu string.
  // The caller guaratees spl_str is valid.
  get_ym_str: function spellingTrie_get_ym_str(spl_str) {
    var start_ZCS = false;
    var pos = 0;
    if (this.is_shengmu_char(spl_str[0])) {
      pos++;
      var prefix = spl_str.substring(0, 2);
      if (prefix == 'Zh' || prefix == 'Ch' || prefix == 'Sh') {
        pos++;
      }
    }
    return spl_str.substring(pos);
  },

  // Build the Yunmu list, and the mapping relation between the full ids and the
  // Yunmu ids. This functin is called after the spelling trie is built.
  build_ym_info: function spellingTrie_build_ym_info() {
    var sucess;
    var spl_table = new SpellingTable();

    sucess = spl_table.init_table();

    for (var pos = 0; pos < this.spelling_num_; pos++) {
      var spl_str = this.spelling_buf_[pos].str;
      spl_str = this.get_ym_str(spl_str);
      if (spl_str) {
        sucess = spl_table.put_spelling(spl_str, 0);
      }
    }

    this.ym_buf_ = spl_table.arrange();
    this.ym_num_ = this.ym_buf_.length;

    // Generate the maping from the spelling ids to the Yunmu ids.
    this.spl_ym_ids_ = [];

    for (var id = 1; id < this.spelling_num_ + SpellingTrie.kFullspl_idStart;
         id++) {
      var str = this.get_spelling_str(id);

      str = this.get_ym_str(str);
      if (str) {
        var ym_id = this.get_ym_id(str);
        this.spl_ym_ids_[id] = ym_id;
      } else {
        this.spl_ym_ids_[id] = 0;
      }
    }
    return true;
  }
};

var RawSpelling = function rawSpelling_constructor(str, freq) {
  this.str = str;
  this.freq = freq;
};

RawSpelling.prototype = {
  str: '',
  freq: 0,
  score: 0
};

/**
 * This class is used to store the spelling strings
 */
var SpellingTable = function spellingTable_constructor() {
};

SpellingTable.kNotSupportList = ['HM', 'HNG', 'NG'];

SpellingTable.prototype = {
  /* ==== Public ==== */

  init_table: function spellingTable_init_table() {
    this.raw_spellings_ = {};
    this.frozen_ = false;
    this.total_freq_ = 0;
    this.score_amplifier_ = 0;
    this.average_score_ = 0;
  },

  /**
   * Put a spelling string to the table.
   * It always returns false if called after arrange() withtout a new
   * init_table() operation.
   * freq is the spelling's occuring count.
   * If the spelling has been in the table, occuring count will accumulated.
   */
  put_spelling: function spellingTable_put_spelling(spelling_str, freq) {
    if (this.frozen_ || !spelling_str)
      return false;

    var notSupportNum = SpellingTable.kNotSupportList.length;
    for (var pos = 0; pos < notSupportNum; pos++) {
      if (spelling_str == SpellingTable.kNotSupportList[pos]) {
        return false;
      }
    }

    this.total_freq_ += freq;

    if (!(spelling_str in this.raw_spellings_)) {
      this.raw_spellings_[spelling_str] = new RawSpelling(spelling_str, 0);
      this.spelling_num_++;
    }

    this.raw_spellings_[spelling_str].freq += freq;

    return true;
  },

  /**
   * Test whether a spelling string is in the table.
   * It always returns false, when being called after arrange() withtout a new
   * init_table() operation.
   */
  contain: function spellingTable_contain(spelling_str) {
    if (this.frozen_ || !spelling_str)
      return false;

    return (spelling_str in this.raw_spellings_);
  },

  /**
   * Sort the spelling strings in an array.
   * @return {RawSpelling[]} Return the sorted RawSpelling array.
   * An item with a lower score has a higher probability.
   * Do not call put_spelling() and contains() after arrange().
   */
  arrange: function spellingTable_arrange() {
    var result = [];
    if (null == this.raw_spellings_) {
      return result;
    }

    var min_score = 1;

    for (var pos in this.raw_spellings_) {
      this.raw_spellings_[pos].freq /= this.total_freq_;
      if (this.raw_spellings_[pos].freq < min_score) {
        min_score = this.raw_spellings_[pos].freq;
      }
    }

    min_score = Math.log(min_score);

    // The absolute value of min_score is bigger than any other scores because
    // the scores are negative after log function.
    this.score_amplifier_ = 1.0 * 255 / min_score;

    var totalScore = 0;
    var spellingNum = 0;
    for (var pos in this.raw_spellings_) {
      var score = Math.floor(Math.log(this.raw_spellings_[pos].freq) *
                             this.score_amplifier_);
      this.raw_spellings_[pos].score = score;
      totalScore += score;
      spellingNum++;
    }
    this.average_score_ = Math.round(totalScore / spellingNum);

    for (var str in this.raw_spellings_) {
      result.push(this.raw_spellings_[str]);
    }

    result.sort(function compare_raw_spl_eb(p1, p2) {
      // "" is the biggest, so that all empty strings will be moved to the end
      if (!p1.str) {
        return 1;
      }
      if (!p2.str) {
        return -1;
      }
      return SearchUtility.compare(p1.str, p2.str);
    });

    this.frozen_ = true;
    return result;
  },

  get_score_amplifier: function spellingTable_get_score_amplifier() {
    return this.score_amplifier_;
  },

  get_average_score: function spellingTable_get_average_score() {
    return this.average_score_;
  },

  /* ==== Private ==== */

  /**
   * The map containing all the RawSpelling whose key is the spelling string.
   */
  raw_spellings_: null,

  total_freq_: 0,

  score_amplifier_: 0,

  average_score_: 0,

  /**
   * If frozen is true, put_spelling() and contain() are not allowed to call.
   */
  frozen_: false
};

var jspinyin = new IMEngine(new PinyinParser());

// Expose jspinyin as an AMD module
if (typeof define === 'function' && define.amd)
  define('jspinyin', [], function() { return jspinyin; });

// Expose to IMEManager if we are in Gaia homescreen
if (typeof IMEManager !== 'undefined')
  IMEController.IMEngines.jspinyin = jspinyin;

// For unit tests
if (typeof Test !== 'undefined') {
  Test.PinyinParser = PinyinParser;
  Test.SpellingTable = SpellingTable;
  Test.SpellingTrie = SpellingTrie;
  Test.FileSystemService = FileSystemService;
  Test.DictBuilder = DictBuilder;
  Test.MyStdlib = MyStdlib;
  Test.SearchUtility = SearchUtility;
}

})();
