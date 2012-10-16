/* -*- Mode: js; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

// JavaScript predictive text engine.
//
// This predictive text engine was contributed by Andreas Gal <gal@mozilla.com>
// and is losely based on the following literature:
//
// Peterson, James (Dec 1980). Computer Programs for Detecting and Correcting
// Spelling Errors.
//
// The following blog post gives a great overview of bloom filters:
// http://ipowerinfinity.wordpress.com/2008/03/02/bloom-filters-designing-a-spellchecker/
//
// Peter Norvig's blog is also a great resource on spell checking:
// http://norvig.com/spell-correct.html
//
// The main difference between the works above and this predictive text engine
// is mapping letters to sets of nearby keys which are used to candidate
// generation. In other words this algorithm mostly tries to correct that you
// hit the wrong key, not that you were actually trying to hit the wrong key.
// However, the candidate generation inevitably also often corrects misspelled
// words.
//
// A second significant difference of this implementation is the focus on word
// prefixes, which are looked up in the bloom filter and the trie. The theory
// behind using prefixes is that we want to automatically complete long words
// after a few keystrokes. This works better for language with shorter average
// word lengths (English). For language with generally long words (German) the
// engine produces a larger amount of matches and the trie is also somewhat
// larger. I don't think this problem can easily be solved. Languages like
// German simply do not lend themselves for auto completion due to their word
// structure.
//
// The differences to the literature above are based on my own experiments, but
// are likely not novel and I would expect most predictive text engines to use
// similar tricks. In particular iPhone's predictive text engine seems to
// return very similar matches than mine, so I suspect they use a prefix trie
// as well.
//
// A note on the dictionary format: The prediction engine uses a custom binary
// dictionary format that is generated by xml2dict.py from a XML-based word
// lists. The word lists included with this engine are minimally modified
// versions of the word lists that ship with Android Jelly Bean (4.1). The
// lists are licensed under the Apache license, as is this engine.
//
// Consult xml2dict.py to understand the format of the dictionary file. The
// purpose of the dictionary file is to compactly represent the trie and the
// bloom filter. We use the binary representation of the trie instead of
// building a trie out of JS objects because JS objects tend to occupy much
// more memory than the binary format xml2dict.py generates.
//
// This module defines a single global variable Predictions which is an
// object with the following methods:
//
//   setDictionary: specifies the dictionary to use
//
//   setLayout: specifies the keyboard layout, which is used to
//      determine the set of nearby keys for each key
//
//   predict: given an input string, return the most likely
//      completions or corrections for it.
//
//   dropDictionary: releases the memory used by the dictionary. This can
//      free up memory when the keyboard is idle and predictions are not
//      needed. When this method is called, the predict() method
//      won't work until setDictionary() has been called again.
//
'use strict';

var Predictions = (function() {

  var _dict; // the dictionary for the current language
  var _prefixLimit; // the maximum length of prefixes (loaded from dictionary)
  var _bloomFilterSize; // the size of the bloom filter (loaded from dictionary)
  var _bloomFilterMask; // mask for offsets into the bloom filter
  var _charMap; // diacritics table (mapping diacritics to the base letter)
  var _start; // starting position of the trie in _dict
  var _nearbyKeys; // nearby keys for any given key
  var _currentWord = ''; // the word currently being edited
  var _maxSuggestions = 3; // max number of suggestions to be returned

  // Send a log message to the main thread since we can't output to the console
  // directly.
  function log(msg) {
    self.postMessage({ cmd: 'log', args: [msg] });
  }

  // Calculate the squared distance of a point (x, y) to the nearest edge of
  // a rectangle (left, top, width, height). This is used to calculate the
  // nearby keys for every key. We search the dictionary by looking for words
  // where each character corresponds to the key the user touched, or a key
  // near that key.
  function SquaredDistanceToEdge(left, top, width, height, x, y) {
    var right = left + width;
    var bottom = top + height;
    var edgeX = x < left ? left : (x > right ? right : x);
    var edgeY = y < top ? top : (y > bottom ? bottom : y);
    var dx = x - edgeX;
    var dy = y - edgeY;
    return dx * dx + dy * dy;
  }

  // Determine whether the key is a special character or a regular letter.
  // Special characters include backspace (8), return (13), and space (32).
  function SpecialKey(key) {
    var code = key.code;
    return code <= 32;
  }

  function Filter(hash) {
    var offset = hash >> 3;
    var bit = hash & 7;
    return !!(_dict[_start + (offset & _bloomFilterMask)] & (1 << bit));
  }

  const LookupPrefix = (function() {
    var pos;

    // Markers used to terminate prefix/offset tables.
    const EndOfPrefixesSuffixesFollow = '#'.charCodeAt(0);
    const EndOfPrefixesNoSuffixes = '&'.charCodeAt(0);

    // Read an unsigned byte.
    function getByte() {
      return _dict[pos++];
    }

    // Read a variable length unsigned integer.
    function getVLU() {
      var u = 0;
      var shift = 0;
      do {
        var b = _dict[pos++];
        u |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      return u;
    }

    // Read a 0-terminated string.
    function getString() {
      var s = '';
      var u;
      while ((u = getVLU()) != 0)
        s += String.fromCharCode(u);
      return s;
    }

    // Return the current position.
    function tell() {
      return pos;
    }

    // Seek to a byte position in the stream.
    function seek(newpos) {
      pos = newpos;
    }

    // Skip over the prefix/offset pairs and find the list of suffixes and add
    // them to the result set.
    function AddSuffixes(prefix, result) {
      while (true) {
        var symbol = getVLU();
        if (symbol == EndOfPrefixesNoSuffixes)
          return result; // No suffixes, done.
        if (symbol == EndOfPrefixesSuffixesFollow) {
          var freq;
          while ((freq = getByte()) != 0) {
            var word = prefix + getString();
            result.push({word: word, freq: freq});
          }
          return; // Done.
        }
        getVLU(); // ignore offset
      }
    }

    // Search matching trie branches at the current position (pos) for the next
    // character in the prefix. Keep track of the actual prefix path taken
    // in path, since we collapse certain characters in to bloom filter
    // (e.g. upper case/lower case). If found, follow the next prefix character
    // if we have not reached the end of the prefix yet, otherwise add the
    // suffixes to the result set.
    function SearchPrefix(prefix, path, result) {
      var p = prefix.charCodeAt(path.length);
      var last = 0;
      while (true) {
        var symbol = getVLU();
        if (symbol == EndOfPrefixesNoSuffixes ||
            symbol == EndOfPrefixesSuffixesFollow) {
          // No matching branch in the trie, done.
          return;
        }
        var offset = getVLU() + last;
        // Matching prefix, follow the branch in the trie.
        if (_charMap[symbol] == p) {
          var saved = tell();
          seek(offset);
          var path2 = path + String.fromCharCode(symbol);
          if (path2.length == prefix.length)
            AddSuffixes(path2, result);
          else
            SearchPrefix(prefix, path2, result);
          seek(saved);
        }
        last = offset;
      }
    }

    return (function(prefix) {
      var result = [];

      // Skip over the header bytes, the diacritics table and the
      // bloom filter data.
      pos = _start + _bloomFilterSize;

      SearchPrefix(prefix, '', result);

      return result;
    });
  })();

  // Generate an array of char codes from a word.
  function String2Codes(codes, word) {
    for (var n = 0, len = word.length; n < len; ++n)
      codes[n] = word.charCodeAt(n);
    return codes;
  }

  // Convert an array of char codes back into a string.
  function Codes2String(codes) {
    return String.fromCharCode.apply(String, codes);
  }

  // Map an array of codes to the base letters, eliminating any diacritics.
  function MapCodesToBaseLetters(codes, length) {
    for (var n = 0; n < length; ++n)
      codes[n] = _charMap[codes[n]];
    return codes;
  }

  // multipliers used in RankCandidate to calculate the
  // final rank of a candidate.

  // promote words where prefix matches
  // ab -> promote words that start with 'ab'
  const PrefixMatchMultiplier = 3;

  // words where accidentaly the wrong key was pressed
  // qas -> was
  // w - neighbourKeys [q,e,a,s,d]
  const EditDistanceMultiplier = 1.8;

  // promote words where 2 characters are swapped
  // tihs -> this
  const TranspositionMultiplier = 1.6;

  // words with a missing character
  // tis -> this
  const OmissionMultiplier = 1.4;

  const DeletionMultiplier = 1.2;

  const RankCandidate = (function() {

    return function(word, cand) {

      var rank = cand.freq;
      var length = cand.word.length;
      var rankMultiplier = cand.rankMultiplier;
      var candWord = cand.word;

      // rank words with smaller edit distance higher up
      // e.g. editdistance = 1, then fact = 1.9
      //      editdistance = 2, then fact = 1.8
      var factor = 1 + ((10 - Math.min(9, cand.distance)) / 10);
      rank *= factor;

      // take input length into account
      // length = 1 then fact = 1.1
      //        = 2 then fact = 1.2
      if (rankMultiplier == PrefixMatchMultiplier) {
        var lengthFactor = 1 + ((Math.min(9, length)) / 10);
        rank *= PrefixMatchMultiplier * lengthFactor;
      }
      else {
        // TranspositionMultiplier, EditDistanceMultiplier
        // OmissionMultiplier, DeletionMultiplier
        rank *= rankMultiplier;
      }

      return rank;
    };
  })();

  // Check a candidate word given as an array of char codes against the bloom
  // filter and if there is a match, confirm it with the prefix trie.
  function Check(input, prefixes, candidates, rankMultiplier) {
    // BIG FAT WARNING: The hash functions used here much match xml2dict.py. If
    // you change one without the other this will break very badly.
    var h1 = 0;
    var h2 = 0xdeadbeef;
    for (var n = 0, len = input.length; n < len; ++n) {
      var ch = input[n];
      h1 = h1 * 33 + ch;
      h1 = h1 & 0xffffffff;
      h2 = h2 * 73 ^ ch;
      h2 = h2 & 0xffffffff;
    }
    if (Filter(h1) && Filter(h2)) {
      var prefix = Codes2String(input);
      if (prefixes.has(prefix))
        return;
      prefixes.add(prefix);
      var result = LookupPrefix(prefix);
      if (result) {
        for (var n = 0, len = result.length; n < len; ++n) {
          var cand = result[n];
          cand.rankMultiplier = rankMultiplier;
          candidates.push(cand);
        }
      }
    }
  }

  // Generate all candidates with an edit distance of 1.
  function EditDistance1(input, prefixes, candidates) {
    var length = input.length;
    for (var n = 0; n < length; ++n) {
      var original = input[n];
      var nearby = _nearbyKeys[String.fromCharCode(original)];
      for (var i = 0, len = nearby.length; i < len; ++i) {
        input[n] = nearby[i].charCodeAt(0);
        Check(input, prefixes, candidates, EditDistanceMultiplier);
      }
      input[n] = original;
    }
  }

  // Generate all candidates with a missing character.
  function Omission1Candidates(input, prefixes, candidates) {
    var length = Math.min(input.length, _prefixLimit - 1);
    var input2 = Uint32Array(length + 1);
    for (var n = 0; n <= length; ++n) {
      for (var i = 0; i < n; ++i)
        input2[i] = input[i];
      while (i < length)
        input2[i + 1] = input[i++];
      for (var ch in _nearbyKeys) {
        input2[n] = ch.charCodeAt(0);
        Check(input2, prefixes, candidates, OmissionMultiplier);
      }
    }
  }

  // Generate all candidates with a single extra character.
  function Deletion1Candidates(input, prefixes, candidates) {
    var length = input.length;
    var input2 = Uint32Array(length - 1);
    for (var n = 1; n < length; ++n) {
      for (var i = 0; i < n; ++i)
        input2[i] = input[i];
      ++i;
      while (i < length)
        input2[i - 1] = input[i++];
      Check(input2, prefixes, candidates, DeletionMultiplier);
    }
  }

  // Generate all candidates with neighboring letters swaped.
  function TranspositionCandidates(input, prefixes, candidates) {
    var length = input.length;
    for (var n = 1; n < length; ++n) {
      // Swap the current letter with the previous letter.
      var a = input[n - 1];
      var b = input[n];
      input[n - 1] = b;
      input[n] = a;
      Check(input, prefixes, candidates, TranspositionMultiplier);
      // Restore the original prefix.
      input[n - 1] = a;
      input[n] = b;
    }
  }

  const LevenshteinDistance = (function() {
    var s_matrix = [];
    var s_a = Uint32Array(64);
    var s_b = Uint32Array(64);

    return function(a, b) {
      var a_length = a.length;
      var b_length = b.length;

      if (!a_length)
        return b_length;
      if (!b_length)
        return a_length;

      // Make sure the static typed arrays we use are long enough to hold the
      // strings.
      if (s_a.length < a_length)
        s_a = Uint32Array(a_length);
      if (s_b.length < b_length)
        s_b = Uint32Array(b_length);

      // Convert both strings to base letters, eliminating all diacritics.
      a = MapCodesToBaseLetters(String2Codes(s_a, a), a.length);
      b = MapCodesToBaseLetters(String2Codes(s_b, b), b.length);

      // Re-use the same array between computations to avoid excessive garbage
      // collections.
      var matrix = s_matrix;

      // Ensure that the matrix is large enough.
      while (matrix.length <= b_length)
        matrix.push([]);

      // Increment along the first column of each row.
      for (var i = 0; i <= b_length; i++)
        matrix[i][0] = i;

      // increment each column in the first row
      for (var j = 0; j <= a_length; j++)
        matrix[0][j] = j;

      // Fill in the rest of the matrix
      for (i = 1; i <= b_length; i++) {
        for (j = 1; j <= a_length; j++) {
          if (b[i - 1] == a[j - 1]) {
            matrix[i][j] = matrix[i - 1][j - 1];
          } else {
            matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, // substitution
                                    Math.min(matrix[i][j - 1] + 1, // insertion
                                             matrix[i - 1][j] + 1)); // deletion
          }
          // Damerau-Levenshtein extension to the base Levenshtein algorithm to
          // support transposition.
          if (i > 1 &&
              j > 1 &&
              b[i - 1] == a[j - 2] &&
              b[i - 2] == a[j - 1]) {
            matrix[i][j] = Math.min(matrix[i][j],
                                    matrix[i - 2][j - 2] +
                                    (b[i - 1] == a[j - 1] ?
                                     0 : // match
                                     1 // transposition
                                    ));
          }
        }
      }

      return matrix[b_length][a_length];
    };
  })();

  // Get the prefix of a word, suitable to be looked up in the bloom filter. We
  // cut off any letters after the first _prefixLimit characters, and convert
  // upper case to lower case and diacritics to the corresponding base letter.
  function GetPrefix(word) {
    // Limit search by prefix to avoid long lookup times.
    var prefix = word.substr(0, _prefixLimit);
    var result = '';
    for (var n = 0, len = prefix.length; n < len; ++n)
      result += String.fromCharCode(_charMap[prefix.charCodeAt(n)]);
    return result;
  }

  function maintainTopCandidates(topCandidates, candidate) {
    var length = topCandidates.length;
    var index = length;
    for (var i = length - 1; i >= 0; i--) {
      if (candidate.word == topCandidates[i].word)
        return;
      if (candidate.rank > topCandidates[i].rank)
        index = i;
    }
    if (index >= _maxSuggestions)
      return;
    topCandidates.splice(index, 0, candidate);
    if (topCandidates.length > _maxSuggestions)
      topCandidates.length = _maxSuggestions;
  }

  // The entry point into the prediction engine. Prediction is a three step
  // process:
  //
  // 1. First we generate a number of possible matches (candidates) by starting
  //    with the first few letters of the word (prefix). When doing so, we also
  //    translate the prefix into lower-case and remove all diacritics and
  //    substitute them with the corresponding base letter. This simplified
  //    prefix is then hashed and we check in a pre-computed bloom filter
  //    whether the trie possibly has a match for this prefix. The bloom filter
  //    is essentially a large bit array. A set bit means that there might be a
  //    match in the trie for this candidate prefix. The bloom filter has a
  //    fairly low false positive rate and is very fast, avoiding expensive
  //    trie lookups.
  //
  // 2. For every hit in the bloom filter we find all entries in the trie that
  //    start with that prefix. When walking through the trie, we recursive
  //    consult every path that matches the prefix. There might be multiple
  //    matching paths since the prefix was converted to lower-case and had all
  //    diacritics removed, whereas the trie stores words in their original
  //    spelling. All matches from the trie are recorded in the candidates
  //    array.
  //
  // 3. Once we have found all candidate matches, we calculate their
  //    Levenshtein distance to the input word and sort the candidates by the
  //    distance. For equal distances we sort by frequency of the match. The
  //    result is then return.
  //
  // IMPORTANT PERFORMANCE NOTE: The code goes to great length to avoid
  // operating on strings. Instead we operate on typed arrays of character
  // codes. This is critical for performance. Strings are immutable and to
  // generate candidates we would have to constantly allocate new strings,
  // which creates a lot of GC garbage. Instead, we convert the prefix of the
  // word we are predicting into a typed array and then mutate that array in
  // place to generate candidates and hash them via the bloom filter.
  //
  function Predict(word) {
    // we need to convert the input word to lower case characters
    // to check the bloomfilter whether the word is in the trie.
    // we use the original input word to promote case matching words
    var lowerCaseWord = word.toLowerCase();

    // This is the list where we will collect all the candidate words.
    var candidates = [];
    // Check for the current input, edit distance 1 and 2 and single letter
    // omission and deletion in the prefix.
    var prefix = GetPrefix(lowerCaseWord);
    var input = String2Codes(new Uint32Array(prefix.length), prefix);
    var prefixes = new Set();
    Check(input, prefixes, candidates, PrefixMatchMultiplier);
    if (word.length > 1) {
      EditDistance1(input, prefixes, candidates);
      Omission1Candidates(input, prefixes, candidates);
      Deletion1Candidates(input, prefixes, candidates);
      TranspositionCandidates(input, prefixes, candidates);
    }

    var finalCandidates = [];
    // Sort the candidates by Levenshtein distance and rank.
    for (var n = 0, len = candidates.length; n < len; ++n) {
      var candidate = candidates[n];

      // Skip candidates equal to input and shorter candidates
      if (candidate.word == word ||
          candidate.word.length < word.length) {
        continue;
      }
      candidate.distance = LevenshteinDistance(lowerCaseWord, candidate.word);
      candidate.rank = RankCandidate(word, candidate);
      maintainTopCandidates(finalCandidates, candidate);
    }
    return finalCandidates;
  }

  function setDictionary(dict) {
    _dict = Uint8Array(dict);

    var pos = 0;

    // Read the header.
    _prefixLimit = _dict[pos++];
    _bloomFilterSize = _dict[pos++] * 65536;
    _bloomFilterMask = _bloomFilterSize - 1;

    // Create the character map that maps all valid characters to lower case
    // and removes all diacritics along the way.
    _charMap = {};
    var set = '0123456789abcdefghijklmnopqrstuvwxyz\'- ';
    for (var n = 0; n < set.length; ++n) {
      var ch = set[n];
      _charMap[ch.charCodeAt(0)] =
        _charMap[ch.toUpperCase().charCodeAt(0)] = ch.charCodeAt(0);
    }
    // Read the diacritics table.
    function getVLU() {
      var u = 0;
      var shift = 0;
      do {
        var b = _dict[pos++];
        u |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      return u;
    }
    var baseLetter;
    while ((baseLetter = getVLU()) != 0) {
      var diacritic;
      while ((diacritic = getVLU()) != 0)
        _charMap[diacritic] = baseLetter;
    }

    // Remember the starting offset of the bloom filter.
    _start = pos;
  }

  function dropDictionary() {
    dump('predictions.js: dropping dictionary\n');
    _dict = null;
  }

  function setLayout(params) {
    // For each key, calculate the keys nearby.
    var keyWidth = params.keyWidth;
    var keyHeight = params.keyHeight;
    var threshold = Math.min(keyWidth, keyHeight) * 1.2;
    var keyArray = params.keyArray;
    _nearbyKeys = {};
    threshold *= threshold;
    for (var n = 0; n < keyArray.length; ++n) {
      var key1 = keyArray[n];
      if (SpecialKey(key1))
        continue;
      var list = '';
      for (var m = 0; m < keyArray.length; ++m) {
        var key2 = keyArray[m];
        if (SpecialKey(key2))
          continue;
        if (SquaredDistanceToEdge(/* key dimensions */
          key1.x, key1.y,
          key1.width, key1.height,
          /* center of candidate key */
          key2.x + key2.width / 2,
          key2.y + key2.height / 2) <
            threshold) {
          list += String.fromCharCode(key2.code).toLowerCase();
        }
      }
      _nearbyKeys[String.fromCharCode(key1.code).toLowerCase()] = list;
    }
  }

  // Return an array of predictions for the given prefix
  function predict(prefix) {
    if (!_dict || !_nearbyKeys) {
      throw Error('not initialized');
    }

    // Get the raw predictions
    var predictions = Predict(prefix);

    // Extract just the words, and capitalize them if needed
    var capitalize = prefix[0] !== prefix[0].toLowerCase();
    var words = predictions.map(function(prediction) {
      var word = prediction.word;
      if (capitalize) {
        word = word[0].toUpperCase() + word.substring(1);
      }
      return word;
    });

    return words;
  }


  return {
    setDictionary: setDictionary,
    dropDictionary: dropDictionary,
    setLayout: setLayout,
    predict: predict
  };
}());
