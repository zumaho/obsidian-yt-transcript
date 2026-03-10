import { requestUrl } from "obsidian";
import {
	parseTranscriptXml,
	parseTranscriptJson3,
	getCaptionTracksFromPage,
	extractVideoTitle,
} from "./api-parser";
import type { TranscriptConfig, TranscriptResponse } from "./types";
import { YoutubeTranscriptError } from "./types";

export { YoutubeTranscriptError } from "./types";
export type {
	TranscriptConfig,
	TranscriptLine,
	TranscriptResponse,
} from "./types";

/**
 * YouTube transcript fetcher using InnerTube Player API.
 * This implementation is based on the approach used by youtube-transcript-api (Python)
 * and obsidian-yt-video-summarizer.
 */
export class YoutubeTranscript {
	// YouTube's public InnerTube API key
	private static readonly INNERTUBE_API_KEY =
		"AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
	private static readonly INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${YoutubeTranscript.INNERTUBE_API_KEY}`;

	// ANDROID client context (matches youtube-transcript-api v1.2.3)
	private static readonly ANDROID_CONTEXT = {
		client: {
			clientName: "ANDROID",
			clientVersion: "20.10.38",
			androidSdkVersion: 30,
			hl: "en",
			gl: "US",
		},
	};

	// WEB client context used as fallback
	private static readonly WEB_CONTEXT = {
		client: {
			clientName: "WEB",
			clientVersion: "2.20240313.00.00",
			hl: "en",
			gl: "US",
		},
	};

	// Player params to bypass ANDROID client integrity checks (NewPipe workaround)
	private static readonly ANDROID_PLAYER_PARAMS = "CgIQBg";

	public static async getTranscript(
		url: string,
		config?: TranscriptConfig,
	): Promise<TranscriptResponse> {
		try {
			// Extract video ID from URL
			const videoId = this.extractVideoIdFromUrl(url);
			if (!videoId) {
				throw new YoutubeTranscriptError(
					new Error(
						"Invalid YouTube URL - could not extract video ID",
					),
				);
			}

			console.log(`🎬 Fetching transcript for video: ${videoId}`);

			// Fetch player data, trying ANDROID client first, then WEB fallback
			const playerData = await this.fetchPlayerDataWithFallback(
				videoId,
				config,
			);

			// Extract video metadata
			const title = playerData.videoDetails?.title || "Unknown";

			// Get caption tracks
			const captionsData =
				playerData.captions?.playerCaptionsTracklistRenderer;
			if (!captionsData || !captionsData.captionTracks) {
				throw new YoutubeTranscriptError(
					new Error("No captions available for this video"),
				);
			}

			console.log(
				`📝 Found ${captionsData.captionTracks.length} caption track(s)`,
			);

			// Find the best matching caption track
			const langCode = config?.lang || "en";
			const captionTrack = this.findCaptionTrack(
				captionsData.captionTracks,
				langCode,
			);
			if (!captionTrack) {
				const availableLangs = captionsData.captionTracks
					.map((t: any) => t.languageCode)
					.join(", ");
				throw new YoutubeTranscriptError(
					new Error(
						`No transcript found for language '${langCode}'. Available: ${availableLangs}`,
					),
				);
			}

			const trackName =
				captionTrack.name?.runs?.[0]?.text ||
				captionTrack.name?.simpleText ||
				captionTrack.languageCode;
			console.log(
				`🔄 Using caption track: ${trackName} (${captionTrack.languageCode})`,
			);

			// Fetch the actual transcript from the caption URL
			const transcriptUrl = captionTrack.baseUrl;
			console.log(
				`📥 Fetching transcript from: ${transcriptUrl.substring(0, 80)}...`,
			);

			const lines = await this.fetchTranscriptFromUrl(transcriptUrl);

			if (lines.length === 0) {
				throw new YoutubeTranscriptError(
					new Error(
						"Transcript response contained no parseable caption lines",
					),
				);
			}

			console.log(
				`✅ Successfully fetched ${lines.length} transcript lines`,
			);

			return {
				title: this.decodeHTML(title),
				lines,
			};
		} catch (err: any) {
			if (err instanceof YoutubeTranscriptError) {
				throw err;
			}
			throw new YoutubeTranscriptError(err);
		}
	}

	/**
	 * Extract video ID from various YouTube URL formats
	 */
	private static extractVideoIdFromUrl(url: string): string | null {
		const patterns = [
			/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
			/^([a-zA-Z0-9_-]{11})$/, // Just the video ID
		];

		for (const pattern of patterns) {
			const match = url.match(pattern);
			if (match) {
				return match[1];
			}
		}
		return null;
	}

	/**
	 * Tries watch page scraping first, then ANDROID client, then WEB client.
	 */
	private static async fetchPlayerDataWithFallback(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<any> {
		// Try watch page scraping first (most reliable)
		try {
			return await this.fetchPlayerDataFromWatchPage(videoId, config);
		} catch (watchPageError: any) {
			console.log(
				`⚠️ Watch page scraping failed: ${watchPageError.message}. Trying InnerTube API...`,
			);
		}

		// Fall back to InnerTube API
		try {
			return await this.fetchPlayerData(videoId, "ANDROID", config);
		} catch (androidError: any) {
			console.log(
				`⚠️ ANDROID client failed: ${androidError.message}. Trying WEB client...`,
			);
			try {
				return await this.fetchPlayerData(videoId, "WEB", config);
			} catch (webError: any) {
				throw androidError;
			}
		}
	}

	/**
	 * Fetches player data by scraping the YouTube watch page HTML.
	 * Extracts ytInitialPlayerResponse to get caption track URLs.
	 */
	private static async fetchPlayerDataFromWatchPage(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<any> {
		const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
		const langCode = config?.lang || "en";

		console.log(`🌐 Fetching watch page: ${watchUrl}`);

		const response = await requestUrl({
			url: watchUrl,
			method: "GET",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				"Accept-Language": `${langCode},en;q=0.9`,
				// CONSENT cookie bypasses YouTube's GDPR consent page
				Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{};",
			},
		});

		const html = response.text;
		if (!html || html.length === 0) {
			throw new Error("Empty response from YouTube watch page");
		}

		console.log(
			`📄 Watch page response: ${html.length} bytes`,
		);

		// Try to extract ytInitialPlayerResponse directly
		const playerResponseMatch = html.match(
			/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script>)/s,
		);

		if (playerResponseMatch) {
			try {
				let playerData;
				try {
					playerData = JSON.parse(playerResponseMatch[1]);
				} catch {
					// If initial parse fails, try brace-matching
					playerData = this.extractJsonFromHtml(
						html,
						"ytInitialPlayerResponse",
					);
				}

				if (playerData) {
					// Check playability
					const status = playerData.playabilityStatus?.status;
					if (status === "ERROR") {
						throw new Error(
							playerData.playabilityStatus?.reason ||
								"Video unavailable",
						);
					}
					if (status === "LOGIN_REQUIRED") {
						throw new Error(
							"This video requires login to view",
						);
					}

					if (
						playerData.captions
							?.playerCaptionsTracklistRenderer
							?.captionTracks
					) {
						// Extract title
						if (!playerData.videoDetails?.title) {
							const title = extractVideoTitle(html);
							if (title) {
								playerData.videoDetails =
									playerData.videoDetails || {};
								playerData.videoDetails.title = title;
							}
						}
						console.log(
							`✅ Extracted player data from ytInitialPlayerResponse`,
						);
						return playerData;
					}
				}
			} catch (e: any) {
				if (
					e.message.includes("unavailable") ||
					e.message.includes("login")
				) {
					throw e;
				}
				console.log(
					`⚠️ Failed to parse ytInitialPlayerResponse: ${e.message}`,
				);
			}
		}

		// Fall back to extracting caption tracks from page HTML using api-parser
		const captionTracks = getCaptionTracksFromPage(html, langCode);
		if (captionTracks.length > 0) {
			const title = extractVideoTitle(html) || "Unknown";
			console.log(
				`✅ Extracted ${captionTracks.length} caption tracks from page HTML`,
			);
			// Build a player-data-like structure
			return {
				videoDetails: { title },
				captions: {
					playerCaptionsTracklistRenderer: {
						captionTracks: captionTracks.map((t) => ({
							baseUrl: t.baseUrl,
							name: { simpleText: t.name },
							languageCode: t.languageCode,
							isTranslatable: t.isTranslatable,
						})),
					},
				},
			};
		}

		throw new Error(
			"Could not extract caption data from watch page",
		);
	}

	/**
	 * Extracts a JSON object from HTML by matching braces starting from a variable assignment.
	 */
	private static extractJsonFromHtml(
		html: string,
		varName: string,
	): any {
		const searchStr = `${varName}`;
		const varIdx = html.indexOf(searchStr);
		if (varIdx === -1) return null;

		const startIdx = html.indexOf("{", varIdx);
		if (startIdx === -1) return null;

		let braceCount = 0;
		let endIdx = startIdx;
		for (let i = startIdx; i < html.length; i++) {
			if (html[i] === "{") braceCount++;
			if (html[i] === "}") braceCount--;
			if (braceCount === 0) {
				endIdx = i + 1;
				break;
			}
		}

		return JSON.parse(html.substring(startIdx, endIdx));
	}

	/**
	 * Fetches player data from YouTube's InnerTube API
	 */
	private static async fetchPlayerData(
		videoId: string,
		clientType: "ANDROID" | "WEB",
		config?: TranscriptConfig,
	): Promise<any> {
		const baseContext =
			clientType === "ANDROID"
				? YoutubeTranscript.ANDROID_CONTEXT
				: YoutubeTranscript.WEB_CONTEXT;

		const context = {
			...baseContext,
			client: {
				...baseContext.client,
				hl: config?.lang || "en",
				gl: config?.country || "US",
			},
		};

		const requestBody: Record<string, any> = {
			context: context,
			videoId: videoId,
		};

		// Add player params for ANDROID to bypass integrity checks
		if (clientType === "ANDROID") {
			requestBody.params = YoutubeTranscript.ANDROID_PLAYER_PARAMS;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (clientType === "ANDROID") {
			headers["User-Agent"] =
				"com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
		}

		console.log(
			`🔄 Calling InnerTube Player API with ${clientType} client...`,
		);

		let response;
		try {
			response = await requestUrl({
				url: YoutubeTranscript.INNERTUBE_PLAYER_URL,
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			});
		} catch (err: any) {
			throw new Error(
				`HTTP request failed for ${clientType} client: ${err.message || err}`,
			);
		}

		const data = JSON.parse(response.text);

		// Check playability status
		const playabilityStatus = data.playabilityStatus;
		if (playabilityStatus) {
			console.log(`📊 Playability status: ${playabilityStatus.status}`);

			if (playabilityStatus.status === "ERROR") {
				throw new Error(
					playabilityStatus.reason || "Video unavailable",
				);
			}
			if (playabilityStatus.status === "LOGIN_REQUIRED") {
				throw new Error("This video requires login to view");
			}
			if (playabilityStatus.status === "UNPLAYABLE") {
				throw new Error(
					playabilityStatus.reason || "Video is unplayable",
				);
			}
		}

		// Verify captions are present in the response
		if (!data.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
			throw new Error(
				`No captions returned by ${clientType} client`,
			);
		}

		return data;
	}

	/**
	 * Finds the best matching caption track for the requested language
	 */
	private static findCaptionTrack(
		captionTracks: any[],
		langCode: string,
	): any {
		// First try exact match
		let track = captionTracks.find((t: any) => t.languageCode === langCode);
		if (track) return track;

		// Try matching language prefix (e.g., 'en' matches 'en-US')
		track = captionTracks.find((t: any) =>
			t.languageCode.startsWith(langCode + "-"),
		);
		if (track) return track;

		// Try finding track where requested lang is a prefix (e.g., 'en-US' when looking for 'en')
		track = captionTracks.find((t: any) =>
			langCode.startsWith(t.languageCode + "-"),
		);
		if (track) return track;

		// Fall back to first available track
		if (captionTracks.length > 0) {
			console.log(
				`⚠️ Language '${langCode}' not found, falling back to '${captionTracks[0].languageCode}'`,
			);
			return captionTracks[0];
		}

		return null;
	}

	/**
	 * Normalizes a caption track URL: ensures absolute URL and optionally sets format.
	 */
	private static normalizeCaptionUrl(
		transcriptUrl: string,
		fmt?: string,
	): string {
		let url = transcriptUrl;
		// Ensure absolute URL (some responses return relative paths)
		if (url.startsWith("/")) {
			url = "https://www.youtube.com" + url;
		}
		if (fmt) {
			// Remove any existing fmt parameter
			url = url.replace(/([?&])fmt=[^&]*(&|$)/, (_, prefix, suffix) =>
				suffix ? prefix : "",
			);
			// Remove trailing & or ?
			url = url.replace(/[?&]$/, "");
			// Add the requested format
			url += (url.includes("?") ? "&" : "?") + `fmt=${fmt}`;
		}
		return url;
	}

	/**
	 * Parses a transcript response, auto-detecting the format (JSON3, XML, or srv3 JSON).
	 */
	private static parseTranscriptResponse(responseText: string): any[] {
		const trimmed = responseText.trim();
		if (!trimmed) return [];

		// Detect format by first character
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			// Try JSON3 format
			const json3Lines = parseTranscriptJson3(trimmed);
			if (json3Lines.length > 0) return json3Lines;
		}

		if (trimmed.startsWith("<") || trimmed.includes("<?xml")) {
			// Try XML format
			const xmlLines = parseTranscriptXml(trimmed);
			if (xmlLines.length > 0) return xmlLines;
		}

		// If format detection didn't work, try both parsers
		const json3Lines = parseTranscriptJson3(trimmed);
		if (json3Lines.length > 0) return json3Lines;

		return parseTranscriptXml(trimmed);
	}

	/**
	 * Fetches transcript from the caption track URL.
	 * Tries the URL as-is first, then with explicit format parameters.
	 */
	private static async fetchTranscriptFromUrl(
		transcriptUrl: string,
	): Promise<any[]> {
		const headers = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			"Accept-Language": "en-US,en;q=0.9",
			Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+{};",
		};

		// Strategy: try multiple URL variations until one returns parseable content
		const urlVariations = [
			{ url: this.normalizeCaptionUrl(transcriptUrl), label: "original" },
			{
				url: this.normalizeCaptionUrl(transcriptUrl, "json3"),
				label: "json3",
			},
			{
				url: this.normalizeCaptionUrl(transcriptUrl, "srv1"),
				label: "srv1 (XML)",
			},
		];

		let lastError: string = "";
		let lastResponsePreview: string = "";

		for (const { url, label } of urlVariations) {
			console.log(
				`📥 Fetching transcript (${label}): ${url.substring(0, 120)}...`,
			);

			try {
				const response = await requestUrl({
					url,
					method: "GET",
					headers,
				});

				const text = response.text;
				console.log(
					`📄 Response (${label}): ${text.length} bytes, starts with: ${JSON.stringify(text.substring(0, 100))}`,
				);

				if (text.length === 0) {
					lastError = `${label}: empty response`;
					continue;
				}

				const lines = this.parseTranscriptResponse(text);
				if (lines.length > 0) {
					console.log(
						`✅ Parsed ${lines.length} lines from ${label} format`,
					);
					return lines;
				}

				lastError = `${label}: response not parseable (${text.length} bytes)`;
				lastResponsePreview = text.substring(0, 200);
			} catch (e: any) {
				lastError = `${label}: ${e.message}`;
				console.log(`⚠️ Fetch failed (${label}): ${e.message}`);
			}
		}

		throw new Error(
			`Failed to fetch transcript from all URL variations. Last error: ${lastError}${lastResponsePreview ? `. Response preview: ${lastResponsePreview}` : ""}`,
		);
	}

	/**
	 * Decodes HTML entities in a text string
	 */
	private static decodeHTML(text: string): string {
		return text
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&#(\d+);/g, (_, code) =>
				String.fromCharCode(parseInt(code, 10)),
			)
			.replace(/\\n/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}
