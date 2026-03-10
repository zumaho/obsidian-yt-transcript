# Handoff: YouTube Transcript 404 Fix

## Current Branch
`claude/fix-404-error-DnD7L`

## Problem
YouTube transcripts fail to load. Two root causes identified:

### 1. Timedtext URLs return 0 bytes (SOLVED in code, needs testing)
- **Root cause**: YouTube requires PO token (`pot=`) for WEB client timedtext URLs since May 2025
- **Fix applied**: Prioritize ANDROID InnerTube client which does NOT require PO tokens
- Same approach as Python `youtube-transcript-api` library (v1.1.0+)
- Ref: https://github.com/yt-dlp/yt-dlp/issues/13075

### 2. get_transcript returns FAILED_PRECONDITION (fallback strategy)
- Returns 400 with `FAILED_PRECONDITION` even with visitorData
- This is Strategy 2 fallback - if ANDROID timedtext works, this is not needed

## What Was Changed

### `src/youtube-transcript.ts`
- **Strategy reorder**: ANDROID InnerTube → watch page → WEB InnerTube (was: watch page → ANDROID → WEB)
- **Minimal headers**: Uses ANDROID user-agent for timedtext fetch (no Sec-Fetch-* needed)
- **PO token support**: Extracts from `serviceIntegrityDimensions.poToken` as additional fallback
- **Watch page prefetch**: Fetches in background for get_transcript fallback data
- **get_transcript**: Tries both with and without API key, uses `X-Goog-Visitor-Id` header

### `src/api-parser.ts`
- Added `extractPoToken()` and `extractPoTokenFromPage()` functions
- Existing: `extractTranscriptParams()`, `extractVisitorData()`, `generateTranscriptParams()`

### `test-fetch.mjs` (CLI test script v4)
- Step 1: Fetch watch page
- Step 2: Extract PO token from `serviceIntegrityDimensions`
- Step 3: Test timedtext URLs with/without PO token
- Step 4: Test get_transcript endpoint
- **Step 5**: KEY TEST - ANDROID InnerTube client caption URLs (should work without PO token)
- Step 6: IOS InnerTube client

## What Needs To Be Done

### 1. Run the test script
```bash
node test-fetch.mjs https://youtu.be/fNSbb-Fjhd8
```

### 2. Interpret results
- **Step 5 success** (ANDROID body > 0 bytes) → Plugin should work. Build and test in Obsidian.
- **Step 5 fail** (ANDROID body = 0 bytes) → Need alternative approach:
  - Check if Step 2 found a PO token
  - Check if Step 3 Test B (with pot=) worked
  - Check Step 4 get_transcript results
  - May need to try different ANDROID client versions or IOS client

### 3. Build and test plugin
```bash
npm run build
```
Then reload Obsidian and test with a YouTube URL.

### 4. If ANDROID approach fails
Possible next steps:
- Try newer ANDROID client version (e.g., `20.20.38`)
- Try `ANDROID_VR` client (`clientName: "ANDROID_VR"`, `clientVersion: "1.60.19"`)
- Use PO token from watch page with WEB timedtext URLs
- Investigate if Obsidian's `requestUrl` behaves differently from Node.js `fetch`

## Architecture Overview
```
getTranscript(url)
  ├── Strategy 1: fetchViaTimedText
  │   ├── fetchPlayerDataWithFallback
  │   │   ├── ANDROID InnerTube /player (priority) ← NEW
  │   │   ├── Watch page scraping (fallback)
  │   │   └── WEB InnerTube /player (last resort)
  │   └── fetchTranscriptFromUrl (caption baseUrl)
  │       ├── original URL (ANDROID - no pot needed)
  │       ├── json3 format
  │       ├── srv1 XML format
  │       ├── original + pot= (WEB fallback)
  │       └── json3 + pot= (WEB fallback)
  │
  └── Strategy 2: fetchViaGetTranscript (fallback)
      ├── Extract params from ytInitialData
      ├── Generate protobuf params
      └── Try each with get_transcript API
          ├── Without API key
          └── With API key
```

## Test Video
https://youtu.be/fNSbb-Fjhd8
