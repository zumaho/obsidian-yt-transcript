import { requestUrl } from "obsidian";
import { parseTranscriptXml } from "./api-parser";
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
	 * Tries ANDROID client first, then falls back to WEB client on failure.
	 */
	private static async fetchPlayerDataWithFallback(
		videoId: string,
		config?: TranscriptConfig,
	): Promise<any> {
		try {
			return await this.fetchPlayerData(videoId, "ANDROID", config);
		} catch (androidError: any) {
			console.log(
				`⚠️ ANDROID client failed: ${androidError.message}. Trying WEB client...`,
			);
			try {
				return await this.fetchPlayerData(videoId, "WEB", config);
			} catch (webError: any) {
				// Throw the original ANDROID error if both fail, as it's usually more informative
				throw androidError;
			}
		}
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
	 * Fetches transcript XML from the caption track URL
	 */
	private static async fetchTranscriptFromUrl(
		transcriptUrl: string,
	): Promise<any[]> {
		const response = await requestUrl({
			url: transcriptUrl,
			method: "GET",
			headers: {
				"Accept-Language": "en-US,en;q=0.9",
			},
		});

		console.log(
			`📄 Transcript response length: ${response.text.length} bytes`,
		);

		if (response.text.length === 0) {
			throw new Error("Received empty transcript response");
		}

		return parseTranscriptXml(response.text);
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
