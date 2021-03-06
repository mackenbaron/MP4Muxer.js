(function moduleExporter(name, closure) {
"use strict";

var entity = GLOBAL["WebModule"]["exports"](name, closure);

if (typeof module !== "undefined") {
    module["exports"] = entity;
}
return entity;

})("MP4Muxer", function moduleClosure(global, WebModule, VERIFY, VERBOSE) {
"use strict";

// --- technical terms / data structure --------------------
/* Usage

- AccessUnit
    - `{ sample_offset, sample_size, AUD, SPS, PPS, SEI, IDR, NON_IDR }`

 */

// --- dependency modules ----------------------------------
var AUD = WebModule["NALUnitAUD"];
var SPS = WebModule["NALUnitSPS"];
var PPS = WebModule["NALUnitPPS"];
var SEI = WebModule["NALUnitSEI"];
var IDR = WebModule["NALUnitIDR"];
var NON_IDR = WebModule["NALUnitNON_IDR"];
var NALUnitType = WebModule["NALUnitType"];
var ParameterSet = WebModule["NALUnitParameterSet"];
var H264Profile = WebModule["H264Profile"];
// --- import / local extract functions --------------------
// --- define / local variables ----------------------------
var SLICE_TYPES = {
        0: "P",     // P_SLICE
        1: "B",     // B_SLICE
        2: "I",     // I_SLICE
        3: "SP",    // SP_SLICE
        4: "SI",    // SI_SLICE
    };
// --- class / interfaces ----------------------------------
var MP4Muxer = {
    "VERBOSE":      VERBOSE,
    "VERBOSE_AU":   VERBOSE,
    "mux":          MP4Muxer_mux, // MP4Muxer.mux(nalUnitObjectArray:NALUnitObjectArray, options:Object = {}):MP4BoxTreeObject
    "repository":   "https://github.com/uupaa/MP4Muxer.js",
};

// --- implements ------------------------------------------
function MP4Muxer_mux(nalUnitObjectArray, // @arg NALUnitObjectArray - [NALUnitObject, ...]
                      options) {          // @arg Object = {} - { videoDuration, audioDuration, parameterSet }
                                          // @options.videoDuration Number = 0.0
                                          // @options.audioDuration Number = 0.0
                                          // @options.parameterSet Object = null - latest ParameterSet
                                          // @ret MP4BoxTreeObject
//{@dev
    if (VERIFY) {
        $valid($type(nalUnitObjectArray, "NALUnitObjectArray"), MP4Muxer_mux, "nalUnitObjectArray");
        $valid($type(options,            "Object|omit"),        MP4Muxer_mux, "options");
        $valid($keys(options,            "videoDuration|audioDuration|parameterSet"), MP4Muxer_mux, "options");
        if (options) {
            $valid($type(options.videoDuration, "Number|omit"),  MP4Muxer_mux, "options.videoDuration");
            $valid($type(options.audioDuration, "Number|omit"),  MP4Muxer_mux, "options.audioDuration");
            $valid($type(options.parameterSet,  "Object|omit"),  MP4Muxer_mux, "options.parameterSet");
        }
    }
//}@dev

    options = options || {};

    var parameterSet    = options["parameterSet"] || new ParameterSet(); // SPS, PPS Container
    var sampleObject    = _createSamples(nalUnitObjectArray, parameterSet); // { samples, stss_samples }
    var samples         = sampleObject.samples; // [ AccessUnit, ... ]
    var samplesLength   = samples.length;

//{@dev
    if (MP4Muxer["VERBOSE"]) {
        var sps = parameterSet["getLatestSPS"]();

        console.info("ftyp", H264Profile["getProfile"](sps["profile_idc"]), "profile",
                             H264Profile["getLevel"](sps["level_idc"]));
    }
//}@dev

    var videoDuration   = options["videoDuration"] || options["audioDuration"] || 0;
    var arrangedTimes   = _arrangeTimeScale(samplesLength, videoDuration); // { duration:UINT32, timescale:UINT32 }
    var mdhd_timescale  = options["timescale"] || arrangedTimes.timescale;
    var mdhd_duration   = mdhd_timescale * videoDuration >>> 0;

    var timescale       = 1000; // 1000 = 1ms
    var duration        = videoDuration * timescale >>> 0;

    var meta = {
            mvhd: {
                timescale:              timescale,
                duration:               duration,   // videoDuration * timescale
                rate:                   0x10000,    // playback rate, 0x10000 >> 16 = 1.0
            },
            tkhd: {
                duration:               duration,   // videoDuration * timescale
                width:                  _getWidth(samples, parameterSet)  << 16, // 16.16 format
                height:                 _getHeight(samples, parameterSet) << 16, // 16.16 format
            },
            elst: {
                segment_duration:       duration,   // videoDuration * timescale
                media_time:             0,
                media_rate_integer:     1,
                media_rate_fraction:    0,
            },
            mdhd: {
                timescale:              mdhd_timescale,
                duration:               mdhd_duration,
            },
            stbl: {
                // stts は duration を格納するテーブルです
                // stsz は sample 毎のサイズを格納するテーブルです
                "stsd": { // Sample description - トラックデータ再生のためのヘッダ情報です
                    "entry_count":          1,
                    "avc1":                 _avc1(samples, parameterSet),
                },
                "stts": { // Time-to-sample - トラックデータの単位ごとの再生時間の表です(Sample毎の時間情報を定義したテーブルです)
                          // 各Sampleの再生時間(duration)は samples[n].sample_delta で定義します
                          // このテーブルに限りテーブルをランレングス圧縮します。entry_count の値は圧縮後のテーブルサイズ(行数)になります
                          // Sample の duration を Samples.length で均等割する場合は、entry_count は 1 で固定にします
                    "entry_count":          1,
                    "samples": [{
                        "sample_count":     samplesLength,
                        "sample_delta":     (mdhd_duration / samplesLength) | 0, // 均等割. 端数は捨てる
                    }]
                },
                "stss": { // stss はランダムアクセスが可能なフレーム(sample)番号のテーブルです
                          // IDR フレームの番号を列挙します
                          // sample_number は 0 ではなく 1 から始まります
                    "entry_count":          sampleObject.stss_samples.length,
                    "samples":              _get_stss_samples(sampleObject.stss_samples),
                },
                "stsc": { // Sample-to-chunk - mdat上のトラックデータの固まりごとの長さ(ビデオの場合はフレーム数)の表です
                          // stsc は1つのChunkに何個サンプルがあるかを定義するテーブルです
                    "entry_count":            1,
                    "samples": [{
                        "first_chunk":        1,
                        "samples_per_chunk":  samplesLength,
                        "sample_description_index": 1,
                    }],
                },
                "stsz": { // Sample size framing - トラックデータ再生単位ごとのデータ長の表です
                          // stsz は Sample 単位の byteSize を格納するテーブルです
                          // stts は duration を格納するテーブルで stsz は sample 毎のサイズを格納するテーブルです
                    "sample_size":          0,
                    "sample_count":         samplesLength,
                    "samples":              _get_stsz_samples(samples),
                },
                "stco": { // Chunk offset - ファイル上のトラックデータの固まりの先頭位置を示す表です
                          // stco は mdat.data 部分の file offset を格納するテーブルです
                    "entry_count":          1,
                    "samples": [{
                        "chunk_offset":     0 // この値は MP4Muxer.mux では分からないため、MP4Builder で最後に設定する事になります
                    }],
                },
            },
        };

    return _buildMP4Box(nalUnitObjectArray, samples, meta);
}

function _buildMP4Box(nalUnitObjectArray, // @arg NALUnitObjectArray - [NALUnitObject, ...]
                      samples,            // @arg AccessUnitArray - [AccessUnit, ...]
                      meta) {             // @arg Object
                                          // @ret MP4BoxTreeObject
    var mp4tree = {
            "root": {
                "ftyp": {
                    "major_brand":          "isom",
                    "minor_version":        512,
                    "compatible_brands":    ["isom", "iso2", "avc1", "mp41"]
                },
                "moov": {
                    "mvhd": {
                        "creation_time":    0,
                        "modification_time": 0,
                        "timescale":        meta.mvhd.timescale,
                        "duration":         meta.mvhd.duration,
                        "rate":             meta.mvhd.rate,
                        "volume":           0x0100,
                        "matrix":           [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824], // fixed value
                        "next_track_ID":    2,  // fixed value
                    },
                    "trak": _trak(meta),
                    "udta": {
                        "meta": {
                            "hdlr": {
                                "handler_type":  0x6d646972, // "mdir"
                                "handler_type2": 0x6170706c, // "appl"
                                "name":          "",
                            },
                            "ilst": {
                                "data": [
                                    0, 0, 0, 37, 169, 116, 111, 111,
                                    0, 0, 0, 29, 100, 97, 116, 97,
                                    0, 0, 0, 1, 0, 0, 0, 0,
                                    76, 97, 118, 102, 53, 54, 46, 52,
                                    48, 46, 49, 48, 49
                                ]
                            },
                        },
                    },
                },
                "mdat": {
                    "data": _create_mdat_data(nalUnitObjectArray)
                },
                "free": {
                    "data": []
                },
            },
        };

    return mp4tree;
}

function _trak(meta) {
    var videoTrack = {
        "tkhd": {
            "flags":                    3, // [!] MAGIC VALUE. UNDOCUMENTED
            "creation_time":            0,
            "modification_time":        0,
            "track_ID":                 1,
            "duration":                 meta.tkhd.duration,
            "layer":                    0,
            "alternate_group":          0,
            "volume":                   0,
            "matrix":                   [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824],
            "width":                    meta.tkhd.width,
            "height":                   meta.tkhd.height,
        },
        "edts": {
            "elst": {
                "entry_count": 1,
                "entries": [{
                    "segment_duration":     meta.elst.segment_duration,
                    "media_time":           meta.elst.media_time,
                    "media_rate_integer":   meta.elst.media_rate_integer,
                    "media_rate_fraction":  meta.elst.media_rate_fraction,
                }],
            },
        },
        "mdia": {
            "mdhd": {
                "creation_time":        0,                      // 4byte
                "modification_time":    0,                      // 4byte
                "timescale":            meta.mdhd.timescale,    // 4byte
                "duration":             meta.mdhd.duration,     // 4byte
                "language":             "und",                  // 3byte
            },
            "hdlr": {
                "handler_type":         0x76696465,             // 4byte "vide"
                "handler_type2":        0x6d646972,             // 4byte "appl" [!][NEED] UNDOCUMENTED
                "name":                 "VideoHandler",         // fixed value
            },
            "minf": {
                "vmhd": {
                    "flags":            1,                      // [!][NEED]
                    "graphicsmode":     0,                      // fixed value
                    "opcolor":          [0, 0, 0],              // fixed value
                },
                "dinf": {
                    "dref": {
                        "entry_count":  1,
                        "url ": [{
                            "flags":    1,                      // [!][NEED]
                            "url":      "",
                        }]
                    },
                },
                "stbl": meta.stbl,
            },
        },
    };
    return [ videoTrack ];
}

function _avc1(samples, parameterSet) {
  //var sps = samples[0].SPS;
  //var pps = samples[0].PPS;
    var sps = parameterSet["getLatestSPS"]();
    var pps = parameterSet["getLatestPPS"]();
    var profile_compatibility = sps["constraint_set0_flag"] << 7 |
                                sps["constraint_set1_flag"] << 6 |
                                sps["constraint_set2_flag"] << 5 |
                                sps["constraint_set3_flag"] << 4 |
                                sps["constraint_set4_flag"] << 3 |
                                sps["constraint_set5_flag"] << 2 |
                                sps["reserved_zero_2bits"];
    return {
        "avcC":                 { // AVCDecoderConfigurationRecord
            "configurationVersion":         1,
            "AVCProfileIndication":         sps["profile_idc"],    // 66 = Baseline profile
                                                                   // 77 = Main profile
                                                                   // 100 = High profile
            "profile_compatibility":        profile_compatibility, // `1100` = Baseline, `0100` = Main
            "AVCLevelIndication":           sps["level_idc"],      // 30 = Level 3.0
            "lengthSizeMinusOne":           3,
            "numOfSequenceParameterSets":   1,
            "SPS": [{
                "sequenceParameterSetLength":   sps["avcC_sequenceParameterSetLength"],
                "sequenceParameterSetNALUnit":  sps["avcC_sequenceParameterSetNALUnit"],
            }],
            "numOfPictureParameterSets":    1,
            "PPS": [{
                "pictureParameterSetLength":    pps["avcC_pictureParameterSetLength"],
                "pictureParameterSetNALUnit":   pps["avcC_pictureParameterSetNALUnit"],
            }]
        },
        "compressorname":       String.fromCharCode.apply(null, new Uint8Array(32)),
        "data_reference_index": 1,
        "depth":                0x18,       // 0x0018
        "frame_count":          1,
        "width":                _getWidth(samples, parameterSet),
        "height":               _getHeight(samples, parameterSet),
        "horizresolution":      0x00480000, // 72dpi = 4718592
        "vertresolution":       0x00480000, // 72dpi = 4718592
    };
}

function _create_mdat_data(nalUnitObjectArray) {
    var buffer = new Uint8Array( _get_mdat_mp4BoxSize(nalUnitObjectArray) );
    var cursor = 0;

    for (var i = 0, iz = nalUnitObjectArray.length; i < iz; ++i) {
        var nalUnit     = nalUnitObjectArray[i]["data"];
        var nalUnitSize = nalUnit.length;

        buffer[cursor + 0] = (nalUnitSize >> 24 & 0xff);
        buffer[cursor + 1] = (nalUnitSize >> 16 & 0xff);
        buffer[cursor + 2] = (nalUnitSize >>  8 & 0xff);
        buffer[cursor + 3] = (nalUnitSize >>  0 & 0xff);

        buffer.set( nalUnit, cursor + 4 );
        cursor += nalUnitSize + 4;
    }
    return buffer;

    function _get_mdat_mp4BoxSize(nalUnitObjectArray) {
        return nalUnitObjectArray.reduce(function(size, nalUnitObject) {
            return size + nalUnitObject["data"].length + 4;
        }, 0);
    }
}

function _createSamples(nalUnitObjectArray, // @arg NALUnitObjectArray - [NALUnitObject, ...]
                        parameterSet) {     // @arg ParameterSet
                                            // @ret Object - { samples:AccessUnitObjectArray, stss_samples:UINT32Array }
    var samples         = [];
    var accessUnit      = null;
    var sample_offset   = 0;
    var stss_samples    = []; // [1, ... ]

//{@dev
    var nal_unit_types  = []; // [nal_unit_type, ...], { 5: "IDR", 6: "SEI", 7: "SPS", 8: "PPS", 9: "AUD" }
    var slice_types     = []; // [slice_type, ...]. { 0: "P", 1: "B", 2: "I", 3: "SP", 4: "SI" }
    var slice_ids       = []; // [slice_id, ...]
//}@dev

    for (var i = 0, iz = nalUnitObjectArray.length; i < iz; ++i) {
        var nalUnitObject = nalUnitObjectArray[i]; // { nal_ref_idc, nal_unit_type, nal_unit_size, index, data, NAL_UNIT_TYPE }
        var nalUnitSize   = nalUnitObject["data"].length;
        var nalUnitType   = nalUnitObject["nal_unit_type"];

        //  Spec:
        //  - SPSとPPSは省略可能
        //      - SPSとPPSは最初のAccessUnitには必ず存在するが、多くの場合に省略されている
        //      - SPSやPPS が存在しない場合は、最後の SPS,PPS を採用する
        //      - SPSやPPSはパケット(nalUnitObjectArray)をまたいで再利用されることがある(AppleのBipbopの2つめのパケットでテストできる)
        //  - VCL NALUnit, 非VCL NALUnit
        //      - nal_unit_type >= 6 なら 非VCL NALUnit
        //      - nal_unit_type <= 5 なら VCL NALUnit
        //

//{@dev
        if (MP4Muxer["VERBOSE_AU"]) {
            if (nalUnitType === 9) { // AUD
                nal_unit_types.push("\n", NALUnitType[nalUnitType]);
            }
            nal_unit_types.push(NALUnitType[nalUnitType]);
        }
//}@dev

        switch (nalUnitType) {
        case 9: // AUD
            if (accessUnit) {
                samples.push(accessUnit);
            }
            accessUnit = _newAcessUnit(sample_offset);
            accessUnit.AUD = new AUD(nalUnitObject, parameterSet);
            break;
        case 7: // SPS
            accessUnit.SPS = new SPS(nalUnitObject, parameterSet); // 仮設定(IDRで再設定する場合もある)
            break;
        case 8: // PPS
            accessUnit.PPS = new PPS(nalUnitObject, parameterSet); // 仮設定(IDRで再設定する場合もある)
            break;
        case 6: // SEI
            accessUnit.SEI = new SEI(nalUnitObject, parameterSet);
            break;
        case 5: // IDR
            stss_samples.push(samples.length + 1); // シーク用にIDRの情報を保存する
            var idr    = new IDR(nalUnitObject, parameterSet);
            var pps_id = idr["pic_parameter_set_id"];
            var sps_id = parameterSet["getPPS"](pps_id)["seq_parameter_set_id"];

            // 仮設定された accessUnit.SPS と accessUnit.PPS が存在する場合もあるが、
            // IDR.pic_parameter_set_id が参照している pps_id と sps_id に再設定する
            accessUnit.SPS = parameterSet["getSPS"](sps_id);
            accessUnit.PPS = parameterSet["getPPS"](pps_id);
            accessUnit.IDR = idr;
//{@dev
            if (MP4Muxer["VERBOSE_AU"]) {
                slice_types.push(SLICE_TYPES[idr["slice_type"] % 5]);
                slice_ids.push(sps_id);
            }
//}@dev
            break;
        case 1: // NON_IDR
            var non_idr = new NON_IDR(nalUnitObject, parameterSet);

            accessUnit.NON_IDR.push(non_idr);
//{@dev
            if (MP4Muxer["VERBOSE_AU"]) {
                nal_unit_types.push(NALUnitType[nalUnitType]);
            }
//}@dev
            break;
        case 12: // FILLER_DATA
            break;
        default:
            console.warn("UNKNOWN NALUnit: " + NALUnitType[nalUnitType] + "(" + nalUnitType + ")");
        }
        sample_offset          += 4 + nalUnitSize; // 4 = NALUnitSize(4byte)
        accessUnit.sample_size += 4 + nalUnitSize;
    }
    if (accessUnit) { // add remain accessUnit
        samples.push(accessUnit);
    }

//{@dev
    if (MP4Muxer["VERBOSE_AU"]) {
        console.info( "slice_types", slice_types.join(",") );
        console.info( "slice_ids", slice_ids.join(",") );
        console.info( nal_unit_types.join(",") );
    }
//}@dev

    return { samples: samples, stss_samples: stss_samples };

    function _newAcessUnit(sample_offset) {
        return {
            sample_offset:  sample_offset,  // mdat の data 部分を起点とした byte offset
            sample_size:    0,              // stsz.sample_size
            AUD:            null,
            SPS:            null,
            PPS:            null,
            SEI:            null,
            IDR:            null,
            NON_IDR:        [],
        };
    }
}

// VideoはMP4全体でWidthとHeightは固定なので、先頭のAUからMP4全体で使用する幅と高さを求める事ができる
function _getWidth(samples, parameterSet) {
    var sps = parameterSet["getLatestSPS"]();
    // http://stackoverflow.com/questions/6394874/fetching-the-dimensions-of-a-h264video-stream
    // http://stackoverflow.com/questions/31919054/h264-getting-frame-height-and-width-from-sequence-parameter-set-sps-nal-unit
    return ((sps["pic_width_in_mbs_minus1"] + 1) * 16) -
             sps["frame_crop_right_offset"] * 2 -
             sps["frame_crop_left_offset"]  * 2;
}

function _getHeight(samples, parameterSet) {
    var sps = parameterSet["getLatestSPS"]();
    // http://stackoverflow.com/questions/6394874/fetching-the-dimensions-of-a-h264video-stream
    // http://stackoverflow.com/questions/31919054/h264-getting-frame-height-and-width-from-sequence-parameter-set-sps-nal-unit
    return ((2 - sps["frame_mbs_only_flag"]) * (sps["pic_height_in_map_units_minus1"] + 1) * 16) -
            (sps["frame_crop_top_offset"]    * 2) -
            (sps["frame_crop_bottom_offset"] * 2);
}

function _get_stss_samples(stss_samples) { // @arg AccessUnitObjectArray - [AccessUnit, ...]
                                           // @ret STSSObjectArray - [{ sample_number }, ... ]
    var result = [];

    for (var i = 0, iz = stss_samples.length; i < iz; ++i) {
        var sample = stss_samples[i];

        result.push({ "sample_number": sample });
    }
    return result;
}

function _get_stsz_samples(samples) { // @arg AccessUnitObjectArray - [AccessUnit, ...]
                                      // @ret STSZObjectArray - [{ entry_size }, ... ]
    var result = [];

    for (var i = 0, iz = samples.length; i < iz; ++i) {
        var sample = samples[i];

        result.push({ "entry_size": sample.sample_size });
    }
    return result;
}

function _arrangeTimeScale(samplesLength, // @arg UINT32
                           duration) {    // @arg Number
                                          // @ret Object - { duration: UINT32, timescale: UINT32 }

    // mdhd_timescale, mdhd_duration を格納する変数は int 型になるため、
    // できるだけ端数がでないようにtimescaleを決めないと誤差がでてしまう
    //
    // [1] duration の小数点第四位までを保証した状態で補正し
    // [2] 2の倍数に丸め
    // [3] samplesLength と duration の最小公倍数を求め返す

    if (samplesLength === 0) {
        throw new Error("BAD ARGUMENT. samplesLength is zero");
    }
    var originalDuration = duration;
    var timescale = 0;

    duration = (duration * 10000) | 0; // [1] 小数点以下4桁まで保持するため 10000倍する
    duration = (duration >> 1) << 1;   // [2] 2の倍数に丸める

    if (samplesLength === 1) {
        timescale = duration;
    } else {
        timescale = _getLeastCommonMultiple(samplesLength, duration); // [3]
    }
    if (MP4Muxer["VERBOSE"]) {
        console.info("original duration = " + originalDuration,
                     "timescale = " + timescale,
                     "samplesLength = " + samplesLength);
    }
    return { duration: duration, timescale: timescale };
}

function _getLeastCommonMultiple(a,   // @arg UINT32
                                 b) { // @arg UINT32
                                      // @ret UINT32
                                      // @desc calculate Least common multiple (lcm 最小公倍数)
    // _getLeastCommonMultiple(12, 18) -> 36
    var r = 1;

    while ( a % 2  === 0 && b % 2  === 0 ) { a /= 2;  b /= 2;  r *= 2;  }
    while ( a % 3  === 0 && b % 3  === 0 ) { a /= 3;  b /= 3;  r *= 3;  }
    while ( a % 5  === 0 && b % 5  === 0 ) { a /= 5;  b /= 5;  r *= 5;  }
    while ( a % 7  === 0 && b % 7  === 0 ) { a /= 7;  b /= 7;  r *= 7;  }
    while ( a % 11 === 0 && b % 11 === 0 ) { a /= 11; b /= 11; r *= 11; }
    while ( a % 13 === 0 && b % 13 === 0 ) { a /= 13; b /= 13; r *= 13; }
  //return r * a * b;
    return 90000;
}

return MP4Muxer; // return entity

});

