// sck_darwin.m — ScreenCaptureKit recorder + CoreAudio device listing (ObjC)
// Called from Go via CGo. Requires macOS 14+.

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreAudio/CoreAudio.h>

// ─── SCK Recorder ───────────────────────────────────────────────────────────

@interface SCKRecorder : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic) int recorderID;
@property (nonatomic, strong) SCStream *stream;
@property (nonatomic, strong) AVAssetWriter *writer;
@property (nonatomic, strong) AVAssetWriterInput *videoInput;
@property (nonatomic, strong) AVAssetWriterInput *audioInput;
@property (nonatomic, strong) dispatch_queue_t sampleQueue; // serial — one frame at a time
@property (nonatomic) BOOL sessionStarted;
@property (nonatomic) BOOL stopping;
@property (nonatomic, copy) NSString *outputPath;
@end

@implementation SCKRecorder

- (void)startWithPath:(NSString *)path captureAudio:(BOOL)audio completion:(void(^)(NSError *))completion {
    self.outputPath = path;
    self.sessionStarted = NO;
    self.stopping = NO;
    // Serial queue: guarantees samples are appended in-order and makes stop
    // sequencing safe (drain with dispatch_sync before markAsFinished).
    self.sampleQueue = dispatch_queue_create("com.randall.sck.samples", DISPATCH_QUEUE_SERIAL);

    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                              onScreenWindowsOnly:NO
                                                completionHandler:^(SCShareableContent *content, NSError *error) {
        if (error || content.displays.count == 0) {
            completion(error ?: [NSError errorWithDomain:@"SCK" code:1
                                               userInfo:@{NSLocalizedDescriptionKey: @"No display found"}]);
            return;
        }

        SCDisplay *display = content.displays.firstObject;
        NSUInteger width = display.width;
        NSUInteger height = display.height;

        // Asset writer
        NSURL *url = [NSURL fileURLWithPath:path];
        [[NSFileManager defaultManager] removeItemAtURL:url error:nil];

        NSError *writerError = nil;
        self.writer = [AVAssetWriter assetWriterWithURL:url fileType:AVFileTypeQuickTimeMovie error:&writerError];
        if (writerError) { completion(writerError); return; }

        // Video input — H.264 via VideoToolbox
        NSDictionary *videoSettings = @{
            AVVideoCodecKey: AVVideoCodecTypeH264,
            AVVideoWidthKey: @(width),
            AVVideoHeightKey: @(height),
            AVVideoCompressionPropertiesKey: @{
                AVVideoAverageBitRateKey: @(5000000),
                AVVideoExpectedSourceFrameRateKey: @(30),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            }
        };
        self.videoInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeVideo outputSettings:videoSettings];
        self.videoInput.expectsMediaDataInRealTime = YES;
        [self.writer addInput:self.videoInput];

        // Audio input
        if (audio) {
            NSDictionary *audioSettings = @{
                AVFormatIDKey: @(kAudioFormatMPEG4AAC),
                AVSampleRateKey: @(44100),
                AVNumberOfChannelsKey: @(2),
                AVEncoderBitRateKey: @(128000),
            };
            self.audioInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio outputSettings:audioSettings];
            self.audioInput.expectsMediaDataInRealTime = YES;
            [self.writer addInput:self.audioInput];
        }

        if (![self.writer startWriting]) {
            completion(self.writer.error ?: [NSError errorWithDomain:@"SCK" code:2
                userInfo:@{NSLocalizedDescriptionKey: @"AVAssetWriter failed to start"}]);
            return;
        }

        // SCStream configuration
        SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
        config.width = width;
        config.height = height;
        config.minimumFrameInterval = CMTimeMake(1, 30);
        config.showsCursor = YES;
        config.pixelFormat = kCVPixelFormatType_32BGRA;

        if (audio) {
            config.capturesAudio = YES;
            config.sampleRate = 44100;
            config.channelCount = 2;
        }

        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        self.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];

        NSError *addError = nil;
        [self.stream addStreamOutput:self
                                type:SCStreamOutputTypeScreen
                  sampleHandlerQueue:self.sampleQueue
                               error:&addError];
        if (addError) { completion(addError); return; }

        if (audio) {
            [self.stream addStreamOutput:self
                                    type:SCStreamOutputTypeAudio
                      sampleHandlerQueue:self.sampleQueue
                                   error:&addError];
            if (addError) { completion(addError); return; }
        }

        [self.stream startCaptureWithCompletionHandler:^(NSError *startError) {
            if (startError) {
                completion(startError);
            } else {
                NSLog(@"SCKRecorder: recording started %lux%lu → %@",
                      (unsigned long)width, (unsigned long)height, path);
                completion(nil);
            }
        }];
    }];
}

- (void)stopWithCompletion:(void(^)(NSError *))completion {
    self.stopping = YES;
    [self.stream stopCaptureWithCompletionHandler:^(NSError *error) {
        // SCKit has stopped delivering frames, but the serial sampleQueue may
        // still have buffered callbacks in-flight. Block until they all finish
        // before marking inputs as done — otherwise appendSampleBuffer: races
        // with markAsFinished and the writer ends up in a failed state.
        dispatch_sync(self.sampleQueue, ^{});

        [self.videoInput markAsFinished];
        if (self.audioInput) [self.audioInput markAsFinished];
        [self.writer finishWritingWithCompletionHandler:^{
            if (self.writer.status == AVAssetWriterStatusFailed) {
                NSLog(@"SCKRecorder: writer failed: %@", self.writer.error);
                completion(self.writer.error);
            } else {
                NSLog(@"SCKRecorder: saved %@", self.outputPath);
                completion(nil);
            }
        }];
    }];
}

// Returns YES only when the screen sample buffer carries a fully-rendered frame.
// SCK also delivers .idle/.blank/.suspended/.stopped buffers whose pixel data
// is nil or stale — appending those silently fails AVAssetWriter.
static BOOL isValidScreenFrame(CMSampleBufferRef buf) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(buf, false);
    if (!attachments || CFArrayGetCount(attachments) == 0) return NO;

    CFDictionaryRef dict = CFArrayGetValueAtIndex(attachments, 0);

    // Check SCStreamFrameInfoStatus == SCFrameStatusComplete (0)
    CFTypeRef statusVal = CFDictionaryGetValue(dict, SCStreamFrameInfoStatus);
    if (!statusVal) return NO;
    CFIndex status;
    CFNumberGetValue((CFNumberRef)statusVal, kCFNumberCFIndexType, &status);
    if (status != SCFrameStatusComplete) return NO;

    // Ensure we actually have a backing pixel buffer / IOSurface
    CVImageBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(buf);
    if (!pixelBuffer) return NO;
    if (!CVPixelBufferGetIOSurface(pixelBuffer)) return NO;

    return YES;
}

// SCStreamOutput — runs on the serial sampleQueue, so no locking needed.
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (self.stopping || self.writer.status != AVAssetWriterStatusWriting) return;
    if (!CMSampleBufferDataIsReady(sampleBuffer)) return;

    if (type == SCStreamOutputTypeScreen) {
        if (!isValidScreenFrame(sampleBuffer)) return;

        if (!self.sessionStarted) {
            CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
            [self.writer startSessionAtSourceTime:pts];
            self.sessionStarted = YES;
        }
        if (self.videoInput.readyForMoreMediaData) {
            [self.videoInput appendSampleBuffer:sampleBuffer];
        }
    } else if (type == SCStreamOutputTypeAudio) {
        if (!self.sessionStarted) return;
        if (self.audioInput && self.audioInput.readyForMoreMediaData) {
            [self.audioInput appendSampleBuffer:sampleBuffer];
        }
    }
}

// SCStreamDelegate
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (!self.stopping) {
        NSLog(@"SCKRecorder: stream error: %@", error);
    }
}

@end

// ─── C API for CGo ──────────────────────────────────────────────────────────

static NSMutableDictionary<NSNumber *, SCKRecorder *> *g_recorders;
static int g_nextID = 1;
static dispatch_once_t g_onceToken;

static void ensureInit(void) {
    dispatch_once(&g_onceToken, ^{
        g_recorders = [NSMutableDictionary new];
    });
}

// Start a recording. Returns recorder ID > 0 on success, -1 on failure.
// errBuf receives a null-terminated error message on failure.
int sckStart(const char *path, int captureAudio, char *errBuf, int errBufLen) {
    ensureInit();

    int rid = g_nextID++;
    SCKRecorder *rec = [[SCKRecorder alloc] init];
    rec.recorderID = rid;
    g_recorders[@(rid)] = rec;

    __block NSError *startErr = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    [rec startWithPath:[NSString stringWithUTF8String:path]
          captureAudio:(captureAudio != 0)
            completion:^(NSError *err) {
        startErr = err;
        dispatch_semaphore_signal(sem);
    }];

    long result = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));

    if (result != 0) {
        [g_recorders removeObjectForKey:@(rid)];
        snprintf(errBuf, errBufLen, "Timeout waiting for ScreenCaptureKit to start");
        return -1;
    }
    if (startErr) {
        [g_recorders removeObjectForKey:@(rid)];
        const char *msg = startErr.localizedDescription.UTF8String;
        snprintf(errBuf, errBufLen, "%s", msg ? msg : "Unknown error");
        return -1;
    }
    return rid;
}

// Stop a recording and finalise the file.
// Returns 0 on success, -1 on failure (errBuf receives the message).
int sckStop(int recorderID, char *errBuf, int errBufLen) {
    ensureInit();
    SCKRecorder *rec = g_recorders[@(recorderID)];
    if (!rec) return 0;

    __block NSError *stopErr = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [rec stopWithCompletion:^(NSError *err) {
        stopErr = err;
        dispatch_semaphore_signal(sem);
    }];
    // Wait indefinitely — AVAssetWriter must finish writing the moov atom before
    // we touch the file; a hard timeout risks copying a truncated/unplayable file.
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    [g_recorders removeObjectForKey:@(recorderID)];

    if (stopErr) {
        const char *msg = stopErr.localizedDescription.UTF8String;
        snprintf(errBuf, errBufLen, "%s", msg ?: "unknown writer error");
        return -1;
    }
    return 0;
}

// ─── Segment concatenation ──────────────────────────────────────────────────

// Merge multiple .mov segments into a single output file using
// AVMutableComposition + AVAssetExportSession (passthrough, no re-encode).
// paths is a C array of pathCount null-terminated UTF-8 strings.
// Returns 0 on success, -1 on failure (errBuf receives the message).
int sckConcat(const char **paths, int pathCount, const char *outputPath, char *errBuf, int errBufLen) {
    @autoreleasepool {
        AVMutableComposition *composition = [AVMutableComposition composition];
        AVMutableCompositionTrack *videoTrack = nil;
        AVMutableCompositionTrack *audioTrack = nil;
        CMTime cursor = kCMTimeZero;

        for (int i = 0; i < pathCount; i++) {
            NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:paths[i]]];
            AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];

            // Load tracks/duration synchronously via semaphore.
            dispatch_semaphore_t loadSem = dispatch_semaphore_create(0);
            [asset loadValuesAsynchronouslyForKeys:@[@"tracks", @"duration"]
                                completionHandler:^{ dispatch_semaphore_signal(loadSem); }];
            dispatch_semaphore_wait(loadSem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));

            NSError *loadErr = nil;
            if ([asset statusOfValueForKey:@"tracks" error:&loadErr] != AVKeyValueStatusLoaded) {
                const char *msg = loadErr.localizedDescription.UTF8String;
                snprintf(errBuf, errBufLen, "Load segment %d failed: %s", i, msg ?: "timeout");
                return -1;
            }

            // tracksWithMediaType: is deprecated on macOS 15 but we already loaded
            // "tracks" above so the values are cached; this is still synchronous and safe.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            NSArray<AVAssetTrack *> *vTracks = [asset tracksWithMediaType:AVMediaTypeVideo];
            NSArray<AVAssetTrack *> *aTracks = [asset tracksWithMediaType:AVMediaTypeAudio];
#pragma clang diagnostic pop

            if (vTracks.count == 0) {
                snprintf(errBuf, errBufLen, "No video track in segment %d", i);
                return -1;
            }

            if (videoTrack == nil) {
                videoTrack = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                                      preferredTrackID:kCMPersistentTrackID_Invalid];
            }

            CMTimeRange range = CMTimeRangeMake(kCMTimeZero, asset.duration);
            NSError *insertErr = nil;
            if (![videoTrack insertTimeRange:range ofTrack:vTracks.firstObject atTime:cursor error:&insertErr]) {
                const char *msg = insertErr.localizedDescription.UTF8String;
                snprintf(errBuf, errBufLen, "Insert video segment %d: %s", i, msg ?: "unknown");
                return -1;
            }

            if (aTracks.count > 0) {
                if (audioTrack == nil) {
                    audioTrack = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                                          preferredTrackID:kCMPersistentTrackID_Invalid];
                }
                [audioTrack insertTimeRange:range ofTrack:aTracks.firstObject atTime:cursor error:nil];
            }

            cursor = CMTimeAdd(cursor, asset.duration);
        }

        NSURL *outURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:outputPath]];
        [[NSFileManager defaultManager] removeItemAtURL:outURL error:nil];

        AVAssetExportSession *session = [[AVAssetExportSession alloc]
            initWithAsset:composition presetName:AVAssetExportPresetPassthrough];
        session.outputURL = outURL;
        session.outputFileType = AVFileTypeQuickTimeMovie;

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [session exportAsynchronouslyWithCompletionHandler:^{ dispatch_semaphore_signal(sem); }];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

        if (session.status != AVAssetExportSessionStatusCompleted) {
            const char *msg = session.error.localizedDescription.UTF8String;
            snprintf(errBuf, errBufLen, "Export failed: %s", msg ?: "unknown");
            return -1;
        }
        return 0;
    }
}

// ─── CoreAudio device listing ───────────────────────────────────────────────

// Returns the number of audio input devices found.
// For each device, writes name into names[i] (caller provides buffer).
int listAudioInputDevices(char names[][256], int maxDevices) {
    AudioObjectPropertyAddress addr;
    addr.mSelector = kAudioHardwarePropertyDevices;
    addr.mScope = kAudioObjectPropertyScopeGlobal;
    addr.mElement = kAudioObjectPropertyElementMain;

    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &dataSize);
    if (status != noErr) return 0;

    int deviceCount = (int)(dataSize / sizeof(AudioDeviceID));
    if (deviceCount == 0) return 0;

    AudioDeviceID *deviceIDs = (AudioDeviceID *)malloc(dataSize);
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &dataSize, deviceIDs);
    if (status != noErr) { free(deviceIDs); return 0; }

    int found = 0;
    for (int i = 0; i < deviceCount && found < maxDevices; i++) {
        // Check if device has input channels
        AudioObjectPropertyAddress streamAddr;
        streamAddr.mSelector = kAudioDevicePropertyStreams;
        streamAddr.mScope = kAudioDevicePropertyScopeInput;
        streamAddr.mElement = kAudioObjectPropertyElementMain;

        UInt32 streamSize = 0;
        status = AudioObjectGetPropertyDataSize(deviceIDs[i], &streamAddr, 0, NULL, &streamSize);
        if (status != noErr || streamSize == 0) continue;

        // Get device name
        AudioObjectPropertyAddress nameAddr;
        nameAddr.mSelector = kAudioObjectPropertyName;
        nameAddr.mScope = kAudioObjectPropertyScopeGlobal;
        nameAddr.mElement = kAudioObjectPropertyElementMain;

        CFStringRef cfName = NULL;
        UInt32 nameSize = sizeof(CFStringRef);
        status = AudioObjectGetPropertyData(deviceIDs[i], &nameAddr, 0, NULL, &nameSize, &cfName);
        if (status != noErr || !cfName) continue;

        CFStringGetCString(cfName, names[found], 256, kCFStringEncodingUTF8);
        CFRelease(cfName);
        found++;
    }

    free(deviceIDs);
    return found;
}
