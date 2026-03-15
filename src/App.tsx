/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { 
  FileText, Download, Loader2, Volume2, 
  Clock, Shield, 
  Mic, Video, Share2, Database, Network, MessageSquare, 
  Film, Search, Plus, Folder, ChevronRight, Image as ImageIcon, Brain
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as d3 from 'd3';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { DEFAULT_LOGO } from './assets/logo';

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const GEMINI_MODEL = "gemini-2.5-flash-preview-tts";
const LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";

interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'error';
  time: string;
}

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: 'entity' | 'date' | 'place' | 'concept';
  val: number;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string;
  target: string;
  value: number;
}

interface Conversation {
  id: string;
  title: string;
  date: string;
  logs: LogEntry[];
  graphData: { nodes: GraphNode[], links: GraphLink[] };
}

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export default function App() {
  const [hasPaidKey, setHasPaidKey] = useState(false);
  const [driveTokens, setDriveTokens] = useState<any>(() => {
    const saved = localStorage.getItem('drive_tokens');
    return saved ? JSON.parse(saved) : null;
  });

  useEffect(() => {
    if (driveTokens) {
      localStorage.setItem('drive_tokens', JSON.stringify(driveTokens));
    } else {
      localStorage.removeItem('drive_tokens');
    }
  }, [driveTokens]);
  const [driveFiles, setDriveFiles] = useState<any[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string>('root');
  const [folderPath, setFolderPath] = useState<{id: string, name: string}[]>([{id: 'root', name: 'Drive'}]);
  const [isFetchingDrive, setIsFetchingDrive] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[], links: GraphLink[] }>({ nodes: [], links: [] });
  const [elapsedTime, setElapsedTime] = useState(0);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string>(Math.random().toString(36).substr(2, 9));
  const [isSaving, setIsSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showNewConvModal, setShowNewConvModal] = useState(false);
  const [newConvTitle, setNewConvTitle] = useState('');
  const [currentTitle, setCurrentTitle] = useState<string>('');
  
  // Agent State
  const [isLive, setIsLive] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isCamOn, setIsCamOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextAudioTimeRef = useRef<number>(0);
  
  // Live API Connection
  const startLiveSession = useCallback(async () => {
    try {
      const apiKey = (process.env as any).API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey });
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: isCamOn ? { width: 640, height: 480 } : false
      });
      streamRef.current = stream;
      if (videoRef.current && isCamOn) {
        videoRef.current.srcObject = stream;
      }

      // Setup Audio Context for input and output
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      nextAudioTimeRef.current = audioContext.currentTime;

      const session = await ai.live.connect({
        model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: "You are ontologiest, semantic, semiotic, expert. Yor name is AIdeaText - Discovery conText, an advanced research quality assistant. Your goal is to help the user build arguments by connecting the following entities: names, dates/days, concepts, time, inventions, countries, cities; using networkg graph. You can analyze uploaded files, but above all, you are a brainstorming partner. Speak naturally, slowly, and clearly. You don't need to wait for the user to finish long blocks; you can interact in real-time. Greet warmly at the beginning and ask what research they are working on today.",
          },
        callbacks: {
          onopen: () => {
            addLog("Live session connected", "success");
            
            // Start sending audio frames
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              if (!sessionRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmData = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
              }
              const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
              sessionRef.current.sendRealtimeInput({
                media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
              });
            };
            
            source.connect(processor);
            processor.connect(audioContext.destination);
            processorRef.current = processor;
          },
          onmessage: (msg: LiveServerMessage) => {
            // Handle Text
            if (msg.serverContent?.modelTurn?.parts[0]?.text) {
              addLog(`Agent: ${msg.serverContent.modelTurn.parts[0].text}`, 'info');
            }
            
            // Handle Audio Output
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && audioContextRef.current) {
              const ctx = audioContextRef.current;
              const binary = atob(audioData);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const pcm = new Int16Array(bytes.buffer);
              const float32 = new Float32Array(pcm.length);
              for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 0x7FFF;
              
              const buffer = ctx.createBuffer(1, float32.length, 24000); // Gemini output is usually 24kHz
              buffer.getChannelData(0).set(float32);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              
              const startTime = Math.max(nextAudioTimeRef.current, ctx.currentTime);
              source.start(startTime);
              nextAudioTimeRef.current = startTime + buffer.duration;
            }

            // Handle Interruption
            if (msg.serverContent?.interrupted) {
              nextAudioTimeRef.current = audioContextRef.current?.currentTime || 0;
            }
          },
          onerror: (err) => addLog(`Live Error: ${err.message}`, 'error'),
          onclose: () => addLog("Live session closed", "info")
        }
      });
      sessionRef.current = session;
      setIsLive(true);
    } catch (err: any) {
      addLog(`Failed to start session: ${err.message}`, 'error');
    }
  }, [isCamOn]);

  const stopLiveSession = useCallback(async () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsLive(false);
    
    // Analizar relaciones al finalizar
    await finalizeGraphWithRelationships();
    
    await saveCurrentConversation();
  }, [logs, graphData, currentConvId]);

  const finalizeGraphWithRelationships = async () => {
    if (logs.length === 0 || graphData.nodes.length === 0) return;
    
    addLog("Finalizing graph: Analyzing relationships between entities...", "info");
    try {
      const apiKey = (process.env as any).API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey });
      
      const transcript = logs.map(l => l.msg).reverse().join('\n');
      const nodesList = graphData.nodes.map(n => `${n.id} (${n.label})`).join(', ');
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{
          parts: [{
            text: `Based on the following conversation transcript and the list of identified entities, identify the relationships (links) between them.
            
            Entities: ${nodesList}
            
            Transcript:
            ${transcript}
            
            Return ONLY a JSON object with a "links" array: { "links": [{ "source": "node_id_1", "target": "node_id_2", "value": 1 }] }. 
            The source and target MUST match the IDs provided in the Entities list. Only include links where a clear relationship is mentioned.`
          }]
        }],
        config: { responseMimeType: "application/json" }
      });

      const result = JSON.parse(response.text || '{}');
      if (result.links && result.links.length > 0) {
        setGraphData(prev => {
          const nodeIds = new Set(prev.nodes.map(n => n.id));
          const validLinks = result.links
            .map((l: any) => ({ ...l, source: String(l.source), target: String(l.target) }))
            .filter((l: any) => nodeIds.has(l.source) && nodeIds.has(l.target));

          return {
            ...prev,
            links: [...prev.links, ...validLinks]
          };
        });
        addLog(`Analysis completed: ${result.links.length} relationships identified.`, "success");
      } else {
        addLog("No clear new relationships detected in this session.", "info");
      }
    } catch (e) {
      addLog("Error finalizing relationship analysis", "error");
    }
  };

  const saveCurrentConversation = async () => {
    if (logs.length === 0) return;
    setIsSaving(true);
    try {
      const conversation: Conversation = {
        id: currentConvId,
        title: currentTitle || logs.find(l => l.msg.startsWith('Agent:'))?.msg.substring(7, 40) || `Conversation ${new Date().toLocaleDateString()}`,
        date: new Date().toISOString(),
        logs,
        graphData
      };
      await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversation)
      });
      loadConversations();
      addLog("Conversation saved automatically", "success");
    } catch (e) {
      addLog("Error saving conversation", "error");
    } finally {
      setIsSaving(false);
    }
  };

  const loadConversations = async () => {
    try {
      const res = await fetch('/api/conversations');
      const data = await res.json();
      setConversations(data.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    } catch (e) {
      addLog("Error loading history", "error");
    }
  };

  const startNewConversation = () => {
    setNewConvTitle('');
    setShowNewConvModal(true);
  };

  const handleConfirmNewConversation = () => {
    stopLiveSession();
    const newId = Math.random().toString(36).substr(2, 9);
    setCurrentConvId(newId);
    setLogs([]);
    setGraphData({ nodes: [], links: [] });
    setCurrentTitle(newConvTitle || 'New Conversation');
    
    const now = new Date();
    const timestamp = now.toLocaleString();
    
    addLog(`New session started: ${newConvTitle || 'Untitled'} (${timestamp})`, "info");
    setShowNewConvModal(false);
  };

  const loadSavedConversation = (conv: Conversation) => {
    stopLiveSession();
    setCurrentConvId(conv.id);
    setLogs(conv.logs);
    setGraphData(conv.graphData);
    setShowHistory(false);
    addLog(`Loaded: ${conv.title}`, "success");
  };

  useEffect(() => {
    loadConversations();
  }, []);

  // Media Processing
  const processMedia = async (file: File) => {
    addLog(`Processing ${file.name}...`, 'info');

    try {
      const apiKey = (process.env as any).API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey });
      
      const fileToBase64 = (f: File): Promise<string> => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(f);
          reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1]);
          };
          reader.onerror = error => reject(error);
        });
      };
      
      const base64 = await fileToBase64(file);
      let mimeType = file.type || 'application/octet-stream';
      
      // Fallback for generic or unsupported types that might be text
      if (mimeType === 'application/octet-stream' || mimeType === 'application/x-zip-compressed') {
        mimeType = 'text/plain';
      }
      
      // Extract entities/concepts using Gemini
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{
          parts: [
            {
              inlineData: {
                data: base64,
                mimeType: mimeType
              }
            },
            {
              text: `Analyze this file. Identify its format and content. Extract key entities, dates, inventions, countries, cities, times, specific places, concepts, and days. 
              Return as JSON: { "summary": "A brief summary of what this file is and what it contains", "nodes": [{ "id": "unique_id", "label": "name", "type": "person|date|invention|country|city|time|place|concept|day" }], "links": [{ "source": "id1", "target": "id2" }] }`
            }
          ]
        }],
        config: { responseMimeType: "application/json" }
      });

      const extracted = JSON.parse(response.text || '{}');
      
      // Update Graph with deduplication and string IDs
      setGraphData(prev => {
        const newNodes = (extracted.nodes || []).map((n: any) => ({ ...n, id: String(n.id), val: 15 }));
        const existingNodeIds = new Set(prev.nodes.map(n => n.id));
        const filteredNewNodes = newNodes.filter(n => !existingNodeIds.has(n.id));
        
        const allNodes = [...prev.nodes, ...filteredNewNodes];
        const allNodeIds = new Set(allNodes.map(n => n.id));
        
        const newLinks = (extracted.links || [])
          .map((l: any) => ({ ...l, source: String(l.source), target: String(l.target) }))
          .filter((l: any) => allNodeIds.has(l.source) && allNodeIds.has(l.target));

        return {
          nodes: allNodes,
          links: [...prev.links, ...newLinks]
        };
      });

      addLog(`Successfully processed ${file.name}`, 'success');
      
      if (extracted.summary) {
        addLog(`File Summary: ${extracted.summary}`, 'info');
        if (isLive && sessionRef.current) {
          sessionRef.current.sendClientContent({
            turns: [{
              role: 'user',
              parts: [{ text: `I just shared a file named ${file.name}. Here is its summary: ${extracted.summary}` }]
            }],
            turnComplete: true
          });
        }
      }
    } catch (err: any) {
      addLog(`Failed to process ${file.name}: ${err.message}`, 'error');
    }
  };

  // Update Graph from Conversation
  useEffect(() => {
    if (logs.length > 0 && logs[0].msg.startsWith('Agent:')) {
      const lastMsg = logs[0].msg;
      const updateGraph = async () => {
        try {
          const apiKey = (process.env as any).API_KEY || process.env.GEMINI_API_KEY;
          const ai = new GoogleGenAI({ apiKey });
          
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{
              parts: [{
                text: `Extract new entities, dates, inventions, countries, cities, times, specific places, concepts, and days from this conversation turn. 
                Return as JSON: { "nodes": [{ "id": "unique_id", "label": "name", "type": "person|date|invention|country|city|time|place|concept|day" }], "links": [{ "source": "id1", "target": "id2" }] } 
                
                Turn: ${lastMsg}`
              }]
            }],
            config: { responseMimeType: "application/json" }
          });

          const extracted = JSON.parse(response.text || '{}');
          if (extracted.nodes?.length > 0 || extracted.links?.length > 0) {
            setGraphData(prev => {
              const newNodes = (extracted.nodes || []).map((n: any) => ({ ...n, id: String(n.id), val: 12 }));
              const existingNodeIds = new Set(prev.nodes.map(n => n.id));
              const filteredNewNodes = newNodes.filter(n => !existingNodeIds.has(n.id));
              
              const allNodes = [...prev.nodes, ...filteredNewNodes];
              const allNodeIds = new Set(allNodes.map(n => n.id));
              
              const newLinks = (extracted.links || [])
                .map((l: any) => ({ ...l, source: String(l.source), target: String(l.target) }))
                .filter((l: any) => allNodeIds.has(l.source) && allNodeIds.has(l.target));

              return {
                nodes: allNodes,
                links: [...prev.links, ...newLinks]
              };
            });
            addLog("Graph updated from conversation.", "success");
          }
        } catch (e) {
          // Silent fail for graph updates
        }
      };
      updateGraph();
    }
  }, [logs]);
  
  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasPaidKey(selected);
      }
    };
    checkKey();
  }, []);

  const addLog = (msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [{ msg, type, time }, ...prev].slice(0, 50));
  };

  const handleSelectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      setHasPaidKey(true);
      addLog("Paid API Key selected. Rate limits increased.", "success");
    }
  };

  const handleConnectDrive = async () => {
    try {
      const response = await fetch('/api/auth/url');
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to get auth URL");
      }
      
      const { url } = data;
      const authWindow = window.open(url, 'google_drive_auth', 'width=600,height=700');
      if (!authWindow) {
        addLog("Popup blocked. Please allow popups for this site.", "error");
      }
    } catch (err: any) {
      addLog(`Failed to get auth URL: ${err.message}`, 'error');
    }
  };

  const fetchDriveFiles = useCallback(async (folderId: string = 'root') => {
    if (!driveTokens?.access_token) return;
    setIsFetchingDrive(true);
    try {
      const query = `'${folderId}' in parents and trashed = false`;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=folder,name&pageSize=100&fields=files(id,name,mimeType)`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${driveTokens.access_token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      setDriveFiles(data.files || []);
      addLog("Google Drive files loaded successfully", "success");
    } catch (e: any) {
      addLog(`Error loading Drive files: ${e.message}`, "error");
    } finally {
      setIsFetchingDrive(false);
    }
  }, [driveTokens]);

  const handleFolderClick = (folderId: string, folderName: string) => {
    setCurrentFolderId(folderId);
    setFolderPath(prev => [...prev, { id: folderId, name: folderName }]);
  };

  const handleBreadcrumbClick = (folderId: string, index: number) => {
    setCurrentFolderId(folderId);
    setFolderPath(prev => prev.slice(0, index + 1));
  };

  const downloadDriveFile = async (fileId: string, fileName: string, mimeType: string) => {
    if (!driveTokens?.access_token) return;
    addLog(`Downloading ${fileName} from Google Drive...`, "info");
    try {
      let url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      let isExport = false;
      let exportMimeType = mimeType;

      if (mimeType === 'application/vnd.google-apps.document') {
        url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
        isExport = true;
        exportMimeType = 'text/plain';
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`;
        isExport = true;
        exportMimeType = 'text/csv';
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
        isExport = true;
        exportMimeType = 'text/plain';
      }

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${driveTokens.access_token}` }
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error?.message || "Failed to download file from Google Drive");
      }
      
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: isExport ? exportMimeType : (res.headers.get('content-type') || 'application/octet-stream') });
      processMedia(file);
    } catch (e: any) {
      addLog(`Error downloading file: ${e.message}`, "error");
    }
  };

  const downloadGraph = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(graphData));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `graph_${currentConvId}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    addLog("Graph exported as JSON", "success");
  };

  const downloadAllHistory = () => {
    window.location.href = '/api/conversations/download';
    addLog("Downloading full conversation history...", "info");
  };

  useEffect(() => {
    if (driveTokens) {
      fetchDriveFiles(currentFolderId);
    }
  }, [driveTokens, currentFolderId, fetchDriveFiles]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setDriveTokens(event.data.tokens);
        addLog("Google Drive connected successfully!", "success");
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      {/* Top Navigation */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-zinc-200 px-6 py-3">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="relative w-12 h-12 flex items-center justify-center">
              <img 
                src={DEFAULT_LOGO} 
                alt="Discovery conText Logo" 
                className="w-full h-full object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-zinc-900 leading-none">Discovery conText</h1>
              <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-widest mt-1">Contextual Research Agent</p>
            </div>
          </div>

          <div className="flex items-center gap-1 bg-zinc-100 p-1 rounded-xl">
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-white text-zinc-900 shadow-sm">
              <MessageSquare className="w-4 h-4" />
              Conversation Workspace
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSelectKey}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium transition-all",
                hasPaidKey 
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200" 
                  : "bg-zinc-900 text-white hover:bg-zinc-800 shadow-sm"
              )}
            >
              <Shield className="w-3 h-3" />
              {hasPaidKey ? 'Paid Quota Active' : 'Use My Credits'}
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[calc(100vh-160px)]">
          {/* Column 1: Google Account & Session & Human */}
          <div className="lg:col-span-4 flex flex-col gap-6 h-full overflow-hidden">
            {/* Google Account Integration - NOW FIRST */}
            <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm p-5 flex flex-col shrink-0 max-h-[45%]">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-zinc-400" />
                  <h3 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Google Account</h3>
                </div>
                {driveTokens && (
                  <div className="flex gap-1">
                    <button 
                      onClick={() => fetchDriveFiles(currentFolderId)}
                      disabled={isFetchingDrive}
                      title="Refresh Files"
                      className="p-1.5 hover:bg-zinc-100 rounded-lg transition-colors"
                    >
                      <Loader2 className={cn("w-3 h-3 text-zinc-400", isFetchingDrive && "animate-spin")} />
                    </button>
                    <button 
                      onClick={() => setDriveTokens(null)}
                      title="Disconnect Account"
                      className="p-1.5 hover:bg-red-50 text-red-400 rounded-lg transition-colors"
                    >
                      <Share2 className="w-3 h-3 rotate-180" />
                    </button>
                  </div>
                )}
              </div>

              {driveTokens && (
                <div className="flex items-center gap-1 mb-3 overflow-x-auto scrollbar-hide pb-1">
                  {folderPath.map((folder, index) => (
                    <div key={folder.id} className="flex items-center shrink-0">
                      <button
                        onClick={() => handleBreadcrumbClick(folder.id, index)}
                        className={cn(
                          "text-[10px] font-medium hover:underline max-w-[80px] truncate",
                          index === folderPath.length - 1 ? "text-zinc-900 font-bold" : "text-zinc-500"
                        )}
                        title={folder.name}
                      >
                        {folder.name}
                      </button>
                      {index < folderPath.length - 1 && (
                        <ChevronRight className="w-3 h-3 text-zinc-300 mx-0.5" />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
                {driveTokens ? (
                  <>
                    {driveFiles.map(file => {
                      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                      return (
                        <div key={file.id} className="flex items-center justify-between p-2 bg-zinc-50 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-all group">
                          <div 
                            className={cn("flex items-center gap-2 overflow-hidden", isFolder ? "cursor-pointer flex-1" : "")}
                            onClick={() => isFolder && handleFolderClick(file.id, file.name)}
                          >
                            <div className="w-6 h-6 bg-white rounded-lg flex items-center justify-center border border-zinc-200 flex-shrink-0">
                              {isFolder ? <Folder className="w-3 h-3 text-yellow-500" /> :
                               file.mimeType.includes('audio') ? <Volume2 className="w-3 h-3 text-blue-500" /> : 
                               file.mimeType.includes('video') ? <Film className="w-3 h-3 text-purple-500" /> : 
                               file.mimeType.includes('image') ? <ImageIcon className="w-3 h-3 text-pink-500" /> : 
                               <FileText className="w-3 h-3 text-emerald-500" />}
                            </div>
                            <span className="text-[10px] font-medium truncate text-zinc-600 group-hover:text-zinc-900 transition-colors">{file.name}</span>
                          </div>
                          {!isFolder && (
                            <button 
                              onClick={() => downloadDriveFile(file.id, file.name, file.mimeType)}
                              title="Process with Agent"
                              className="p-1.5 hover:bg-zinc-900 rounded-md text-zinc-400 hover:text-white transition-colors"
                            >
                              <Brain className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {driveFiles.length === 0 && !isFetchingDrive && (
                      <p className="text-[10px] text-center text-zinc-400 py-2">No files found in this folder</p>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 px-4 border-2 border-dashed border-zinc-100 rounded-2xl bg-zinc-50/50">
                    <Database className="w-8 h-8 text-zinc-200 mb-3" />
                    <p className="text-[11px] text-zinc-500 text-center mb-4 font-medium">
                      Authenticate to enable Google Drive context for the agent
                    </p>
                    <button 
                      onClick={handleConnectDrive}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-zinc-900 text-white rounded-xl text-xs font-bold hover:bg-zinc-800 transition-all shadow-md active:scale-[0.98]"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      Connect Google Account
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Session Controls - NOW SECOND */}
            <div className="bg-white rounded-3xl border border-zinc-200 p-4 flex items-center justify-between shadow-sm shrink-0">
              <button 
                onClick={startNewConversation}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-xs font-bold hover:bg-zinc-800 transition-all"
              >
                <Plus className="w-3 h-3" />
                New
              </button>
              <div className="flex gap-2">
                <button 
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-2 px-4 py-2 bg-zinc-100 text-zinc-600 rounded-xl text-xs font-bold hover:bg-zinc-200 transition-all"
                >
                  <Clock className="w-3 h-3" />
                  History
                </button>
                {isSaving && <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />}
              </div>
            </div>

            {/* Human Webcam */}
            <div className="h-1/4 bg-zinc-900 rounded-3xl border border-zinc-200 shadow-sm overflow-hidden relative group shrink-0">
              {isCamOn ? (
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600 gap-2">
                  <Video className="w-8 h-8 opacity-20" />
                  <p className="text-[10px] font-medium">Camera disabled</p>
                </div>
              )}
              
              <div className="absolute top-3 left-3 flex items-center gap-2 px-2 py-1 bg-black/40 backdrop-blur-md rounded-lg border border-white/10">
                <div className="w-1.5 h-1.5 bg-white rounded-full" />
                <span className="text-[9px] font-bold text-white uppercase tracking-tighter">Human</span>
              </div>

              {/* Controls Overlay */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => setIsMicOn(!isMicOn)}
                  className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center transition-all",
                    isMicOn ? "bg-white text-zinc-900" : "bg-white/10 text-white hover:bg-white/20"
                  )}
                >
                  <Mic className="w-3.5 h-3.5" />
                </button>
                <button 
                  onClick={() => setIsCamOn(!isCamOn)}
                  className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center transition-all",
                    isCamOn ? "bg-white text-zinc-900" : "bg-white/10 text-white hover:bg-white/20"
                  )}
                >
                  <Video className="w-3.5 h-3.5" />
                </button>
                <div className="w-px h-3 bg-white/20 mx-0.5" />
                <button 
                  onClick={() => {
                    if (isLive) stopLiveSession();
                    else if (driveTokens) startLiveSession();
                    else addLog("Please connect your Google Account first to provide context to the agent.", "error");
                  }}
                  disabled={!driveTokens && !isLive}
                  className={cn(
                    "px-3 py-1 rounded-xl font-bold text-[9px] transition-all",
                    isLive 
                      ? "bg-red-500 text-white hover:bg-red-600" 
                      : (!driveTokens ? "bg-zinc-800/50 text-zinc-500 cursor-not-allowed" : "bg-white text-zinc-900 hover:bg-zinc-100")
                  )}
                >
                  {!driveTokens && !isLive ? 'Connect Drive to Start' : (isLive ? 'End' : 'Start')}
                </button>
              </div>
            </div>

            {/* Agent Avatar */}
            <div className="flex-1 bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden flex flex-col items-center justify-center p-6 relative min-h-0">
              <div className="absolute top-4 left-6 flex items-center gap-2">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Virtual Agent</span>
              </div>
              
              <AgentAvatar isLive={isLive} />
              
              <div className="mt-4 text-center">
                <h3 className="text-lg font-bold text-zinc-900">Discovery conText</h3>
                <p className="text-[10px] text-zinc-500 mt-1">Listening and analyzing...</p>
              </div>

              {isLive && (
                <div className="mt-4 flex items-center gap-1 h-6">
                  {[...Array(12)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ 
                        height: [6, Math.random() * 24 + 6, 6],
                      }}
                      transition={{ 
                        repeat: Infinity, 
                        duration: 0.5 + Math.random() * 0.5,
                        ease: "easeInOut"
                      }}
                      className="w-1 bg-zinc-900 rounded-full"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Column 2: Knowledge Graph */}
          <div className="lg:col-span-8 bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden relative flex flex-col">
            <div className="p-6 border-b border-zinc-100 flex items-center justify-between bg-white/50 backdrop-blur-sm z-10">
              <div>
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <Network className="w-5 h-5 text-zinc-400" />
                  Real-Time Interaction Graph
                </h3>
                <p className="text-xs text-zinc-500">Automatically identifying entities and relationships</p>
              </div>
              <div className="flex gap-2">
                <button className="p-2 hover:bg-zinc-100 rounded-xl transition-colors">
                  <Share2 className="w-4 h-4 text-zinc-400" />
                </button>
                <button 
                  onClick={downloadGraph}
                  className="p-2 hover:bg-zinc-100 rounded-xl transition-colors"
                >
                  <Download className="w-4 h-4 text-zinc-400" />
                </button>
              </div>
            </div>

            <div className="flex-1 relative">
              <GraphVisualization data={graphData} />
              
              {/* History Sidebar Overlay */}
              <AnimatePresence>
                {showHistory && (
                  <motion.div
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '100%' }}
                    className="absolute inset-y-0 right-0 w-80 bg-white/95 backdrop-blur-xl border-l border-zinc-200 z-30 shadow-2xl p-6 flex flex-col"
                  >
                    <div className="flex items-center justify-between mb-6">
                      <h3 className="font-bold text-zinc-900">Session History</h3>
                      <div className="flex gap-2">
                        <button 
                          onClick={downloadAllHistory}
                          title="Download All History"
                          className="p-2 hover:bg-zinc-100 rounded-full text-zinc-400 hover:text-zinc-600"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-zinc-100 rounded-full">
                          <Plus className="w-4 h-4 rotate-45" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                      {conversations.map(conv => (
                        <button
                          key={conv.id}
                          onClick={() => loadSavedConversation(conv)}
                          className={cn(
                            "w-full text-left p-4 rounded-2xl border transition-all group",
                            currentConvId === conv.id 
                              ? "bg-zinc-900 border-zinc-900 text-white" 
                              : "bg-white border-zinc-100 hover:border-zinc-300 text-zinc-600"
                          )}
                        >
                          <p className="text-xs font-bold truncate mb-1">{conv.title}</p>
                          <div className="flex items-center justify-between opacity-60">
                            <span className="text-[10px]">{new Date(conv.date).toLocaleDateString()}</span>
                            <span className="text-[10px]">{conv.logs.length} messages</span>
                          </div>
                        </button>
                      ))}
                      {conversations.length === 0 && (
                        <div className="text-center py-12 text-zinc-400">
                          <Database className="w-8 h-8 mx-auto mb-3 opacity-20" />
                          <p className="text-xs">No saved conversations</p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Legend Overlay */}
              <div className="absolute bottom-6 left-6 flex flex-wrap gap-2 max-w-md">
                {[
                  { label: 'Names', color: '#3B82F6' },
                  { label: 'Dates/Days', color: '#10B981' },
                  { label: 'Inventions', color: '#F59E0B' },
                  { label: 'Countries/Cities', color: '#EF4444' },
                  { label: 'Concepts', color: '#8B5CF6' },
                  { label: 'Time', color: '#EC4899' },
                ].map(tag => (
                  <div key={tag.label} className="flex items-center gap-2 px-2.5 py-1 bg-white/80 backdrop-blur-md border border-zinc-100 rounded-lg text-[10px] font-bold shadow-sm">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                    {tag.label}
                  </div>
                ))}
              </div>
            </div>

            {/* Mini Log Overlay */}
            <div className="absolute bottom-6 right-6 w-64 max-h-48 bg-white/80 backdrop-blur-md border border-zinc-100 rounded-2xl shadow-xl p-4 overflow-hidden flex flex-col">
              <h4 className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-2">Recent Activity</h4>
              <div className="flex-1 overflow-y-auto space-y-2 scrollbar-hide">
                {logs.slice(0, 5).map((log, i) => (
                  <div key={i} className="text-[10px] leading-tight">
                    <span className={cn(
                      "font-bold",
                      log.type === 'error' ? "text-red-500" : 
                      log.type === 'success' ? "text-emerald-600" : "text-zinc-500"
                    )}>
                      • {log.msg.length > 60 ? log.msg.substring(0, 60) + '...' : log.msg}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* New Conversation Modal */}
      <AnimatePresence>
        {showNewConvModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl border border-zinc-200 w-full max-w-md overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 bg-zinc-900 rounded-2xl flex items-center justify-center text-white">
                    <Plus className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-zinc-900">New Meeting</h3>
                    <p className="text-sm text-zinc-500">Define the title to begin</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1.5 ml-1">
                      Conversation Name
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={newConvTitle}
                      onChange={(e) => setNewConvTitle(e.target.value)}
                      placeholder="e.g., Q1 Market Analysis"
                      className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all text-sm"
                      onKeyDown={(e) => e.key === 'Enter' && handleConfirmNewConversation()}
                    />
                  </div>

                  <div className="bg-zinc-50 rounded-2xl p-4 border border-zinc-100">
                    <div className="flex items-center justify-between text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">
                      <span>Date and Time</span>
                      <Clock className="w-3 h-3" />
                    </div>
                    <p className="text-sm font-medium text-zinc-600">
                      {new Date().toLocaleString('en-US', { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 mt-8">
                  <button
                    onClick={() => setShowNewConvModal(false)}
                    className="flex-1 px-6 py-3 bg-zinc-100 text-zinc-600 rounded-2xl text-sm font-bold hover:bg-zinc-200 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmNewConversation}
                    className="flex-1 px-6 py-3 bg-zinc-900 text-white rounded-2xl text-sm font-bold hover:bg-zinc-800 shadow-lg shadow-zinc-900/20 transition-all"
                  >
                    Start
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentAvatar({ isLive }: { isLive: boolean }) {
  return (
    <div className="relative">
      <motion.div
        animate={isLive ? {
          scale: [1, 1.05, 1],
          rotate: [0, 1, -1, 0],
        } : {}}
        transition={{ repeat: Infinity, duration: 4 }}
        className="w-48 h-48 rounded-full bg-gradient-to-tr from-zinc-900 to-zinc-700 p-1 shadow-2xl"
      >
        <div className="w-full h-full rounded-full bg-white flex items-center justify-center overflow-hidden border-4 border-zinc-100">
          <img 
            src="https://picsum.photos/seed/ai-avatar/400/400" 
            alt="AI Avatar" 
            className={cn("w-full h-full object-cover transition-opacity duration-500", isLive ? "opacity-100" : "opacity-40 grayscale")}
            referrerPolicy="no-referrer"
          />
        </div>
      </motion.div>
      
      {isLive && (
        <>
          <motion.div
            animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="absolute inset-0 rounded-full border-4 border-zinc-900"
          />
          <motion.div
            animate={{ scale: [1, 2, 1], opacity: [0.3, 0, 0.3] }}
            transition={{ repeat: Infinity, duration: 3 }}
            className="absolute inset-0 rounded-full border-2 border-zinc-400"
          />
        </>
      )}
    </div>
  );
}

function GraphVisualization({ data }: { data: { nodes: GraphNode[], links: GraphLink[] } }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const g = svg.append("g");

    // Define arrow marker
    svg.append("defs").append("marker")
      .attr("id", "arrowhead")
      .attr("viewBox", "-0 -5 10 10")
      .attr("refX", 28) // Position arrow at the edge of the node
      .attr("refY", 0)
      .attr("orient", "auto")
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("xoverflow", "visible")
      .append("svg:path")
      .attr("d", "M 0,-5 L 10 ,0 L 0,5")
      .attr("fill", "#000000")
      .style("stroke", "none");

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    svg.call(zoom);

    // Resilience: Ensure all IDs are strings and filter invalid links
    const nodeIds = new Set(data.nodes.map(n => String(n.id)));
    const displayNodes = data.nodes.map(n => ({ ...n, id: String(n.id) }));
    const displayLinks = data.links
      .filter(l => {
        const sourceId = typeof l.source === 'object' ? (l.source as any).id : String(l.source);
        const targetId = typeof l.target === 'object' ? (l.target as any).id : String(l.target);
        return nodeIds.has(sourceId) && nodeIds.has(targetId);
      })
      .map(l => ({
        ...l,
        source: typeof l.source === 'object' ? (l.source as any).id : String(l.source),
        target: typeof l.target === 'object' ? (l.target as any).id : String(l.target)
      }));

    const simulation = d3.forceSimulation<GraphNode>(displayNodes)
      .force("link", d3.forceLink<GraphNode, GraphLink>(displayLinks).id(d => d.id).distance(150))
      .force("charge", d3.forceManyBody().strength(-500))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(60));

    const link = g.append("g")
      .selectAll("line")
      .data(displayLinks)
      .join("line")
      .attr("stroke", "#000000")
      .attr("stroke-opacity", 0.8)
      .attr("stroke-width", d => Math.sqrt(d.value || 1) * 1.5)
      .attr("marker-end", "url(#arrowhead)");

    const node = g.append("g")
      .selectAll("g")
      .data(displayNodes)
      .join("g")
      .call(d3.drag<SVGGElement, GraphNode>()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended) as any);

    const colors: Record<string, string> = {
      person: '#3B82F6',   // Names
      date: '#10B981',     // Dates
      day: '#10B981',      // Days
      invention: '#F59E0B',// Inventions
      country: '#EF4444',  // Countries
      city: '#EF4444',     // Cities
      place: '#EF4444',    // Places
      concept: '#8B5CF6',  // Concepts
      time: '#EC4899',     // Time
      entity: '#3B82F6'    // Default
    };

    node.append("circle")
      .attr("r", d => d.val + 10)
      .attr("fill", "white")
      .attr("stroke", d => colors[d.type])
      .attr("stroke-width", 3)
      .attr("class", "shadow-sm");

    node.append("text")
      .attr("dy", d => d.val + 25)
      .attr("text-anchor", "middle")
      .attr("font-size", "12px")
      .attr("font-weight", "600")
      .attr("fill", "#1A1A1A")
      .text(d => d.label);

    simulation.on("tick", () => {
      link
        .attr("x1", d => (d.source as any).x)
        .attr("y1", d => (d.source as any).y)
        .attr("x2", d => (d.target as any).x)
        .attr("y2", d => (d.target as any).y);

      node
        .attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event: any) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event: any) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    return () => { simulation.stop(); };
  }, [data]);

  return <svg ref={svgRef} className="w-full h-full cursor-grab active:cursor-grabbing" />;
}

// Helper to split text into chunks
function splitIntoChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];

  for (const sentence of sentences) {
    if ((current + sentence).length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
