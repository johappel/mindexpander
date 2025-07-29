/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {GoogleGenAI} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash';

interface Note {
  id: string;
  rawTranscription: string;
  polishedNoteMarkdown: string; // Stores raw Markdown for copy
  polishedNoteHtml: string;    // Stores HTML for display
  timestamp: number;
}

class VoiceNotesApp {
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private summaryDisplay: HTMLDivElement; // Renamed from thoughtHistoryDisplay
  private newButton: HTMLButtonElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private currentSummary: string = ""; // Renamed from currentThoughtHistory
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;
  private hasAttemptedPermission = false;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.API_KEY!,
    });

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.summaryDisplay = document.getElementById( // Renamed ID from thoughtHistory
        'summaryDisplay',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector(
      'i',
    ) as HTMLElement;
    this.editorTitle = document.querySelector(
      '.editor-title',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        'Live waveform canvas element not found. Visualizer will not work.',
      );
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      console.warn('Recording interface element not found.');
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.initTheme();
    this.createNewNote(); 

    this.setRecordingStatus('Bereit zur Aufnahme');
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    window.addEventListener('resize', this.handleResize.bind(this));

    // Copy as Markdown for Polished Note
    this.polishedNote.addEventListener('copy', (event) => {
      if (this.currentNote && this.currentNote.polishedNoteMarkdown) {
        event.clipboardData?.setData('text/plain', this.currentNote.polishedNoteMarkdown);
        event.preventDefault();
      }
    });
  }

  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      localStorage.setItem('theme', 'dark');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        'One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Unbenannter Entwurf';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder
        ? currentTitle
        : 'Neue Aufnahme'; // Localized

    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private setRecordingStatus(status: string): void {
    if (this.recordingStatus) {
        this.recordingStatus.textContent = status;
    }
  }

  private async startRecording(): Promise<void> {
    try {
      this.audioChunks = [];
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }

      this.setRecordingStatus('Mikrofonzugriff wird angefordert...');

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.error('Failed with basic constraints:', err);
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: 'audio/webm',
        });
      } catch (e) {
        console.error('audio/webm not supported, trying default:', e);
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        this.stopLiveDisplay();

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {
            type: this.mediaRecorder?.mimeType || 'audio/webm',
          });
          this.processAudio(audioBlob).catch((err) => {
            console.error('Error processing audio:', err);
            this.setRecordingStatus('Fehler bei der Audioverarbeitung');
          });
        } else {
          this.setRecordingStatus('Keine Audiodaten erfasst. Bitte erneut versuchen.');
        }

        if (this.stream) {
          this.stream.getTracks().forEach((track) => {
            track.stop();
          });
          this.stream = null;
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;

      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Aufnahme stoppen');

      this.startLiveDisplay();
    } catch (error) {
      console.error('Error starting recording:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';

      if (
        errorName === 'NotAllowedError' ||
        errorName === 'PermissionDeniedError'
      ) {
        this.setRecordingStatus('Mikrofonberechtigung verweigert. Bitte Browsereinstellungen prüfen und Seite neu laden.');
      } else if (
        errorName === 'NotFoundError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Requested device not found'))
      ) {
        this.setRecordingStatus('Kein Mikrofon gefunden. Bitte ein Mikrofon anschließen.');
      } else if (
        errorName === 'NotReadableError' ||
        errorName === 'AbortError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Failed to allocate audiosource'))
      ) {
        this.setRecordingStatus('Zugriff auf Mikrofon nicht möglich. Es wird möglicherweise von einer anderen Anwendung verwendet.');
      } else {
        this.setRecordingStatus(`Fehler: ${errorMessage}`);
      }

      this.isRecording = false;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Aufnahme starten');
      this.stopLiveDisplay();
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.error('Error stopping MediaRecorder:', e);
        this.stopLiveDisplay(); 
      }

      this.isRecording = false;

      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Aufnahme starten');
      this.setRecordingStatus('Audio wird verarbeitet...');
    } else {
      if (!this.isRecording) this.stopLiveDisplay(); 
    }
  }

  private async processAudio(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) {
      this.setRecordingStatus('Keine Audiodaten erfasst. Bitte erneut versuchen.');
      return;
    }

    try {
      URL.createObjectURL(audioBlob); 

      this.setRecordingStatus('Audio wird konvertiert...');

      const reader = new FileReader();
      const readResultPromise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          try {
            if (typeof reader.result === 'string') {
              const parts = reader.result.split(',');
              if (parts.length === 2 && typeof parts[1] === 'string') {
                resolve(parts[1]);
              } else {
                reject(new Error('Ungültiges Base64-Datenformat nach dem Teilen. Erwartet: "data:[<mediatype>][;base64],<data>"'));
              }
            } else {
              reject(new Error('FileReader-Ergebnis ist kein String.'));
            }
          } catch (err) { 
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        reader.onerror = () => {
          reject(reader.error || new Error('Unbekannter FileReader-Fehler ist aufgetreten.'));
        };
        try {
            reader.readAsDataURL(audioBlob);
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      const base64Audio: string = await readResultPromise;

      if (!base64Audio) { 
        throw new Error('Fehler beim Konvertieren von Audio zu Base64 (leeres Ergebnis).');
      }

      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      await this.getTranscription(base64Audio, mimeType);
    } catch (error) {
      console.error('Error in processAudio:', error);
      this.setRecordingStatus('Fehler bei der Audioverarbeitung. Bitte erneut versuchen.');
    }
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    try {
      this.setRecordingStatus('Transkription wird abgerufen...');

      const contents = [
        {text: 'Erstelle ein vollständiges, detailliertes Transkript dieses Audios auf Deutsch.'}, // Added German instruction
        {inlineData: {mimeType: mimeType, data: base64Audio}},
      ];

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });
      
      // FIX: Ensure response.text is resolved to a string, accommodating string | Promise<string>
      const transcriptionText: string = await Promise.resolve(response.text);

      if (transcriptionText) {
        this.setPanelContent(this.rawTranscription, transcriptionText);

        if (this.currentNote)
          this.currentNote.rawTranscription = transcriptionText;
        this.setRecordingStatus('Transkription vollständig. Notiz wird überarbeitet...');
        
        await this.getPolishedNote(transcriptionText);

      } else {
        this.setRecordingStatus('Transkription fehlgeschlagen oder leer.');
        this.setPanelContent(this.polishedNote, '<p><em>Audio konnte nicht transkribiert werden. Bitte erneut versuchen.</em></p>', true);
        this.setPanelContent(this.rawTranscription, ''); 
      }
    } catch (error) {
      console.error('Error getting transcription:', error);
      this.setRecordingStatus('Fehler beim Abrufen der Transkription. Bitte erneut versuchen.');
      this.setPanelContent(this.polishedNote, `<p><em>Fehler während der Transkription: ${error instanceof Error ? error.message : String(error)}</em></p>`, true);
      this.setPanelContent(this.rawTranscription, '');
    }
  }

  private async getPolishedNote(rawTranscription: string): Promise<void> {
    try {
      if (
        !rawTranscription ||
        rawTranscription.trim() === ''
      ) {
        this.setRecordingStatus('Keine Transkription zum Überarbeiten vorhanden.');
        this.setPanelContent(this.polishedNote, '<p><em>Keine Transkription zum Überarbeiten verfügbar.</em></p>', true);
        if (this.currentNote) {
            this.currentNote.polishedNoteMarkdown = "";
            this.currentNote.polishedNoteHtml = "<p><em>Keine Transkription zum Überarbeiten verfügbar.</em></p>";
        }
        return;
      }

      this.setRecordingStatus('Notiz wird überarbeitet...');

      const polishPrompt = `Nimm dieses Roh-Transkript von gesprochenen Gedanken und strukturiere es in eine klare, zusammenhängende Notiz unter Verwendung von Markdown. Die Ausgabe soll auf Deutsch sein.
Organisiere den Inhalt logisch mit Überschriften, Unterüberschriften (falls zutreffend), Aufzählungspunkten oder nummerierten Listen, je nach Inhalt.
Verwende Fettung zur Hervorhebung von Schlüsselbegriffen oder Aktionspunkten.
Stelle sicher, dass alle Kernideen aus dem Transkript korrekt erfasst werden.
Entferne Füllwörter (z.B. "äh", "ähm", "sozusagen", "weißt du"), unnötige Wiederholungen und falsche Ansätze, um die Lesbarkeit zu verbessern.
Das Ziel ist es, die gesprochene Diktatnotiz in ein gut strukturiertes, leicht scanbares und umsetzbares Markdown-Dokument FÜR DIESE SPEZIFISCHE DIKTATNOTIZ umzuwandeln.
Wenn der Inhalt sehr kurz ist oder eine einzelne Idee darstellt, kann ein einfacher Absatz ausreichen, aber wende dennoch Markdown für Hervorhebungen oder Links an, falls vorhanden.

Roh-Transkript:
${rawTranscription}`;

      const contents = [{text: polishPrompt}];

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });
      
      // FIX: Ensure response.text is resolved to a string, accommodating string | Promise<string>
      const polishedMarkdown: string = await Promise.resolve(response.text);

      if (polishedMarkdown) {
        const htmlContent = marked.parse(polishedMarkdown);
        this.setPanelContent(this.polishedNote, htmlContent, true);
        
        this.updateEditorTitle(polishedMarkdown);

        if (this.currentNote) {
            this.currentNote.polishedNoteMarkdown = polishedMarkdown;
            this.currentNote.polishedNoteHtml = htmlContent;
        }
        
        this.setRecordingStatus('Überarbeitet. Zusammenfassung wird aktualisiert...');
        await this.updateSummary(polishedMarkdown); // Renamed method
        
        this.setRecordingStatus('Notiz überarbeitet und Zusammenfassung aktualisiert. Bereit für nächste Aufnahme.');

      } else {
        this.setRecordingStatus('Überarbeitung fehlgeschlagen oder leer.');
        const emptyPolishMsg = '<p><em>Überarbeitung lieferte leeres Ergebnis. Roh-Transkript ist verfügbar.</em></p>';
        this.setPanelContent(this.polishedNote, emptyPolishMsg , true);
         if (this.currentNote) {
            this.currentNote.polishedNoteMarkdown = "";
            this.currentNote.polishedNoteHtml = emptyPolishMsg;
        }
      }
    } catch (error) {
      console.error('Error polishing note:', error);
      this.setRecordingStatus('Fehler beim Überarbeiten der Notiz. Bitte erneut versuchen.');
      const errorMsg = `<p><em>Fehler während der Überarbeitung: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.setPanelContent(this.polishedNote, errorMsg, true);
       if (this.currentNote) {
            this.currentNote.polishedNoteMarkdown = ""; // No markdown on error
            this.currentNote.polishedNoteHtml = errorMsg;
        }
      this.setPanelContent(this.summaryDisplay, `<p><em>Zusammenfassung konnte aufgrund eines Überarbeitungsfehlers nicht aktualisiert werden.</em></p>`, true);
    }
  }

  private async updateSummary(newlyPolishedThoughtMarkdown: string): Promise<void> { // Renamed method
    try {
      this.setRecordingStatus('Zusammenfassung wird aktualisiert...');
      this.setPanelContent(this.summaryDisplay, '<p><em>Zusammenfassung wird aktualisiert...</em></p>', true);


      const summaryPrompt = `Du bist ein KI-Assistent, der dabei hilft, eine kontinuierliche, sich entwickelnde Zusammenfassung auf Deutsch zu erstellen.
Dir werden eine "Bestehende Zusammenfassung" (die leer sein kann, wenn dies der erste Gedanke ist) und ein "Neu diktierter Gedanke" gegeben.
Deine Aufgabe ist es, den "Neu diktierten Gedanke" intelligent in die "Bestehende Zusammenfassung" zu integrieren.
Dies ist nicht nur ein einfaches Anhängen. Du solltest:
1. Den Kontext der "Bestehenden Zusammenfassung" verstehen.
2. Den "Neu diktierten Gedanke" verstehen.
3. Die kombinierten Informationen überarbeiten, neu anordnen, zusammenführen oder zusammenfassen, um eine neue, kohärente "Aktualisierte Zusammenfassung" zu erstellen.
4. Wenn der neue Gedanke eine direkte Fortsetzung ist, erweitere die Erzählung.
5. Wenn der neue Gedanke ein neues Thema einführt, organisiere es logisch innerhalb der Zusammenfassung.
6. Wenn der neue Gedanke einen vorherigen Punkt überarbeitet oder verdeutlicht, aktualisiere die Zusammenfassung entsprechend.
7. Einen konsistenten Ton und Stil beibehalten.
8. Sicherstellen, dass die Ausgabe gut strukturiert und lesbar ist.
9. Die "Aktualisierte Zusammenfassung" im Markdown-Format und auf Deutsch ausgeben.

Bestehende Zusammenfassung:
${this.currentSummary || "Noch keine vorherige Zusammenfassung."}

Neu diktierter Gedanke (Markdown):
${newlyPolishedThoughtMarkdown}

Aktualisierte Zusammenfassung (Markdown, Deutsch):`;

      const contents = [{ text: summaryPrompt }];
      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });

      // FIX: Ensure response.text is resolved to a string, accommodating string | Promise<string>
      const updatedSummaryText: string = await Promise.resolve(response.text);

      if (updatedSummaryText) {
        this.currentSummary = updatedSummaryText; // Renamed variable
        const htmlContent = marked.parse(this.currentSummary);
        this.setPanelContent(this.summaryDisplay, htmlContent, true);
        this.setRecordingStatus('Zusammenfassung aktualisiert.');
      } else {
        this.currentSummary += `\n\n---\n\n**Neuer Gedanke (Integration fehlgeschlagen):**\n${newlyPolishedThoughtMarkdown}`;
        const htmlContent = marked.parse(this.currentSummary);
        this.setPanelContent(this.summaryDisplay, htmlContent + "<p><em>Fehler beim Abrufen einer integrierten Aktualisierung von der KI, neuer Gedanke wurde angehängt.</em></p>", true);
        this.setRecordingStatus('Aktualisierung der Zusammenfassung fehlgeschlagen, neuer Gedanke angehängt.');
      }
    } catch (error) {
        console.error('Error updating summary:', error);
        this.currentSummary += `\n\n---\n\n**Neuer Gedanke (Fehler während der Aktualisierung der Zusammenfassung: ${error instanceof Error ? error.message : String(error)}):**\n${newlyPolishedThoughtMarkdown}`;
        const htmlContent = marked.parse(this.currentSummary);
        this.setPanelContent(this.summaryDisplay, htmlContent, true);
        this.setRecordingStatus('Fehler beim Aktualisieren der Zusammenfassung. Neuer Gedanke angehängt.');
    }
  }


  private updateEditorTitle(polishedMarkdown: string): void {
    let noteTitleSet = false;
    const lines = polishedMarkdown.split('\n').map((l) => l.trim());

    for (const line of lines) {
      if (line.startsWith('# ')) { 
        const title = line.replace(/^#\s+/, '').trim();
        if (this.editorTitle && title) {
          this.setPanelContent(this.editorTitle, title);
          noteTitleSet = true;
          break;
        }
      }
    }

    if (!noteTitleSet && this.editorTitle) {
      for (const line of lines) {
        if (line.length > 0 && !line.startsWith('#')) { 
          let potentialTitle = line.replace(/^[\*_\`\->\s\[\]\(.\d)]+/, '');
          potentialTitle = potentialTitle.replace(/[\*_\`#]+$/, '');
          potentialTitle = potentialTitle.trim();

          if (potentialTitle.length > 3) {
            const maxLength = 60;
            this.setPanelContent(this.editorTitle, potentialTitle.substring(0, maxLength) +
              (potentialTitle.length > maxLength ? '...' : ''));
            noteTitleSet = true;
            break;
          }
        }
      }
    }
    if (!noteTitleSet && this.editorTitle && this.editorTitle.textContent?.trim() === '' && !this.editorTitle.classList.contains('placeholder-active')) {
        this.setPanelContent(this.editorTitle, ''); 
    }
  }

  private setPanelContent(element: HTMLElement, content: string, isHtml = false): void {
    const placeholder = element.getAttribute('placeholder') || '';
    if (!content || content.trim() === '') {
      if (isHtml) {
        element.innerHTML = placeholder;
      } else {
        element.textContent = placeholder;
      }
      element.classList.add('placeholder-active');
    } else {
      if (isHtml) {
        element.innerHTML = content;
      } else {
        element.textContent = content;
      }
      element.classList.remove('placeholder-active');
    }
  }


  private createNewNote(): void {
    this.currentNote = {
      id: `note_${Date.now()}`,
      rawTranscription: '',
      polishedNoteMarkdown: '',
      polishedNoteHtml: '',
      timestamp: Date.now(),
    };
    this.currentSummary = ""; // Renamed variable

    this.setPanelContent(this.rawTranscription, '');
    this.setPanelContent(this.polishedNote, '', true); 
    this.setPanelContent(this.summaryDisplay, '', true); // Renamed element
    
    if (this.editorTitle) {
      this.setPanelContent(this.editorTitle, '');
    }
    this.setRecordingStatus('Bereit zur Aufnahme');

    if (this.isRecording) {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this.mediaRecorder.onstop = null; 
        this.mediaRecorder.stop();
      }
      this.isRecording = false;
      this.recordButton.classList.remove('recording');
      this.stopLiveDisplay(); 
       if (this.stream) {
          this.stream.getTracks().forEach((track) => track.stop());
          this.stream = null;
        }
    } else {
      this.stopLiveDisplay();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new VoiceNotesApp();

  document.querySelectorAll<HTMLElement>('[contenteditable="true"][placeholder]').forEach((el) => {
      const placeholder = el.getAttribute('placeholder')!;

      function updatePlaceholderState() {
        const currentText = (el.id === 'polishedNote' ? el.innerHTML : el.textContent);
        // For contenteditable, an empty field might still have a <br> or similar.
        // We consider it "empty" for placeholder purposes if its visible text content is empty.
        const isEmpty = el.innerText.trim() === '';

        if (isEmpty) {
            if (el.classList.contains('placeholder-active')) return; // Already showing placeholder

            // For polishedNote (which can take HTML), set placeholder HTML.
            // For others, set placeholder text.
            if (el.id === 'polishedNote') el.innerHTML = placeholder;
            else el.textContent = placeholder;
            el.classList.add('placeholder-active');
        } else if (el.classList.contains('placeholder-active') && currentText !== placeholder) {
            // If it's not empty and IS showing placeholder text (e.g. user focused then blurred without typing)
            // but the actual content isn't the placeholder text itself, remove placeholder styles.
            // This case is less common with the current focus/blur logic but good for robustness.
             el.classList.remove('placeholder-active');
        } else if (!isEmpty && !el.classList.contains('placeholder-active') && currentText === placeholder) {
            // If it has content, is not styled as placeholder, but content IS placeholder text
            // (e.g. user pasted placeholder text in), do nothing, let it be actual content.
        } else if (!isEmpty) {
             el.classList.remove('placeholder-active');
        }
      }
      
      updatePlaceholderState();

      el.addEventListener('focus', function () {
        if (this.classList.contains('placeholder-active') && 
            ( (this.id === 'polishedNote' && this.innerHTML === placeholder) || 
              (this.id !== 'polishedNote' && this.textContent === placeholder) )
           ) {
          if (this.id === 'polishedNote') this.innerHTML = ''; 
          else this.textContent = ''; 
          this.classList.remove('placeholder-active');
        }
      });

      el.addEventListener('blur', function () {
        // If after blur the content is truly empty (ignoring potential <br> for contenteditable)
        if (this.innerText.trim() === '') {
            if (this.id === 'polishedNote') this.innerHTML = placeholder;
            else this.textContent = placeholder;
            this.classList.add('placeholder-active');
        } else {
             this.classList.remove('placeholder-active'); // Ensure it's removed if content exists
        }
      });
    });
});

export {};
