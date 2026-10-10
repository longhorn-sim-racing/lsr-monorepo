"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { 
    previewParseResult, 
    bindEventToUpload, 
    deleteUpload, 
    ingestUpload 
} from "@/app/admin/results/actions";
import { type RawResultUpload, type User, type ParseReport } from "@prisma/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ResultWithRelations = RawResultUpload & {
  uploadedBy: User;
  parseReport: ParseReport | null;
};

type EventSummary = {
    id: string;
    title: string;
    startsAtUtc: Date;
}


/** One row of parseReport.drivers, as previewParseResult writes it */
type ParsedDriver = { guid: string; driverName: string; carModel: string };
export function ResultDetailClient({ 
    result: initialResult,
    events 
}: { 
    result: ResultWithRelations,
    events: EventSummary[]
}) {
  const [result, setResult] = useState(initialResult);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState(result.eventId || "");
  const [selectedSessionLabel, setSelectedSessionLabel] = useState(result.sessionLabel || "RACE");
  const [selectedPointsSystem, setSelectedPointsSystem] = useState(result.pointsSystem || "F1");
  const router = useRouter();

  const isNonRace = selectedSessionLabel === "PRACTICE" || selectedSessionLabel === "QUALIFYING";

  const handleParse = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const parsed = await previewParseResult(result.id);
      if (!parsed.ok) setError(parsed.error);
      else setResult(parsed.data as ResultWithRelations);
    } catch (error) {
      console.error(error);
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setIsProcessing(false);
    }
  };
  
  const handleBindEvent = async () => {
      if (!selectedEventId) return;
      setIsProcessing(true);
      setError(null);
      try {
          const effectivePoints = isNonRace ? "NONE" : selectedPointsSystem;
          const bound = await bindEventToUpload(result.id, selectedEventId, effectivePoints, selectedSessionLabel);
          if (!bound.ok) {
              setError(bound.error);
              return;
          }
          router.refresh();
          setResult(prev => ({
              ...prev,
              eventId: selectedEventId,
              pointsSystem: effectivePoints,
              sessionLabel: selectedSessionLabel
          }));
      } catch (e) {
          console.error(e);
          setError("Something went wrong. Check your connection and try again.");
      } finally {
          setIsProcessing(false);
      }
  };

  const handleIngest = async () => {
      if (!confirm("Are you sure you want to ingest this result? This will create official records.")) return;
      setIsProcessing(true);
      setProgress(10);
      setError(null);

      // Simulate progress
      const interval = setInterval(() => {
          setProgress(prev => {
              if (prev >= 90) return prev;
              return prev + (95 - prev) * 0.1; // Slow down as it approaches 95
          });
      }, 500);

      try {
          const ingested = await ingestUpload(result.id);
          if (!ingested.ok) {
              setError(ingested.error);
              return;
          }
          setProgress(100);
          router.refresh();
          setResult(prev => ({ ...prev, status: "INGESTED" }));
      } catch (e) {
          console.error(e);
          setError("Something went wrong. Check your connection and try again.");
      } finally {
          clearInterval(interval);
          setTimeout(() => {
            setIsProcessing(false);
            setProgress(0);
          }, 500);
      }
  };
  
  const handleDelete = async (force: boolean) => {
      if (!confirm(force ? "DELETE EVERYTHING including ingested data?" : "Delete upload?")) return;
      setIsProcessing(true);
      try {
          const deleted = await deleteUpload(result.id, force);
          if (!deleted.ok) {
              setError(deleted.error);
              setIsProcessing(false);
              return;
          }
          router.push("/admin/results");
      } catch (e) {
          console.error(e);
          setError("Something went wrong. Check your connection and try again.");
          setIsProcessing(false);
      }
  };

  const hasChanges = selectedEventId !== result.eventId
    || selectedPointsSystem !== (result.pointsSystem || "F1")
    || selectedSessionLabel !== (result.sessionLabel || "RACE");

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-6">
        <Button asChild variant="outline">
          <Link href="/admin/results">Back to Results List</Link>
        </Button>
        <div className="space-x-2">
            <Button variant="destructive" onClick={() => handleDelete(false)} disabled={isProcessing || result.status === 'INGESTED'}>Delete Upload</Button>
             {/* Only show force delete if ingested or if needed */}
             {result.status === 'INGESTED' && (
                 <Button variant="destructive" onClick={() => handleDelete(true)} disabled={isProcessing}>Force Delete (Un-Ingest)</Button>
             )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{result.filename}</CardTitle>
          <CardDescription>
            Uploaded by {result.uploadedBy.displayName} on{" "}
            {new Date(result.uploadedAt).toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p>Status: <span className="font-bold">{result.status}</span></p>
          <p>Size: {result.filesize} bytes</p>
          <p>SHA256: {result.sha256}</p>
          
          <div className="mt-4 p-4 border rounded bg-muted/50 space-y-4">
             <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                 <div className="space-y-2">
                     <label className="font-medium text-sm">Assigned Event</label>
                     <select
                        className="w-full p-2 border rounded bg-background text-foreground"
                        value={selectedEventId}
                        onChange={(e) => setSelectedEventId(e.target.value)}
                        disabled={isProcessing || result.status === 'INGESTED'}
                     >
                         <option value="">-- Select Event --</option>
                         {events.map(e => (
                             <option key={e.id} value={e.id}>
                                 {new Date(e.startsAtUtc).toLocaleDateString()} - {e.title}
                             </option>
                         ))}
                     </select>
                 </div>

                 <div className="space-y-2">
                     <label className="font-medium text-sm">Session Type</label>
                     <select
                        className="w-full p-2 border rounded bg-background text-foreground"
                        value={selectedSessionLabel}
                        onChange={(e) => setSelectedSessionLabel(e.target.value)}
                        disabled={isProcessing || result.status === 'INGESTED'}
                     >
                         <option value="PRACTICE">Practice</option>
                         <option value="QUALIFYING">Qualifying</option>
                         <option value="RACE">Race</option>
                     </select>
                     {isNonRace && (
                         <p className="text-xs text-muted-foreground">Points disabled for non-race sessions</p>
                     )}
                 </div>

                 <div className="space-y-2">
                     <label className="font-medium text-sm">Points Ruleset</label>
                     <select
                        className="w-full p-2 border rounded bg-background text-foreground"
                        value={isNonRace ? "NONE" : selectedPointsSystem}
                        onChange={(e) => setSelectedPointsSystem(e.target.value)}
                        disabled={isProcessing || result.status === 'INGESTED' || isNonRace}
                     >
                         <option value="F1">F1 (Default)</option>
                         <option value="HALF">Half Points</option>
                         <option value="NONE">None</option>
                     </select>
                 </div>
             </div>
             
             <div className="flex justify-end">
                <Button 
                    onClick={handleBindEvent} 
                    disabled={isProcessing || result.status === 'INGESTED' || !hasChanges}
                    size="sm"
                >
                    Save Changes
                </Button>
             </div>
          </div>
          
          {result.errorMessage && <p className="text-red-500 font-mono bg-red-50 p-2 rounded">Error: {result.errorMessage}</p>}

          {progress > 0 && (
            <div className="w-full bg-muted rounded-full h-2.5 mt-4 overflow-hidden">
              <div 
                className="bg-primary h-2.5 transition-all duration-500 ease-out" 
                style={{ width: `${progress}%` }}
              ></div>
              <p className="text-xs text-muted-foreground mt-1 animate-pulse">
                {progress < 100 ? "Ingesting data, please wait..." : "Ingestion complete!"}
              </p>
            </div>
          )}
        </CardContent>
        <CardFooter className="gap-2">
            <Button onClick={handleParse} disabled={isProcessing}>
                {isProcessing ? "Processing..." : "Preview / Parse"}
            </Button>
            
            <Button 
                onClick={handleIngest} 
                disabled={isProcessing || !result.eventId || result.status === 'INGESTED' || !result.parseReport}
                variant="default"
            >
                Ingest Results
            </Button>
        </CardFooter>
      </Card>
      
      {error && <p className="text-red-500 bg-red-50 p-4 rounded border border-red-200">{error}</p>}

      {result.parseReport && (
        <Card>
          <CardHeader>
            <CardTitle>Parse Report</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                    <h3 className="font-bold">Counts</h3>
                    <p>Results: {result.parseReport.resultsCount}</p>
                    <p>Laps: {result.parseReport.lapsCount}</p>
                </div>
            </div>

            <h3 className="font-bold mb-2">Drivers ({(result.parseReport?.drivers as ParsedDriver[] | null)?.length || 0})</h3>
            <div className="max-h-96 overflow-auto border rounded">
                <Table>
                <TableHeader>
                    <TableRow>
                    <TableHead>GUID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Car</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {(result.parseReport.drivers as ParsedDriver[]).map((driver) => (
                    <TableRow key={driver.guid}>
                        <TableCell className="font-mono text-xs">{driver.guid}</TableCell>
                        <TableCell>{driver.driverName}</TableCell>
                        <TableCell>{driver.carModel}</TableCell>
                    </TableRow>
                    ))}
                </TableBody>
                </Table>
            </div>

            {result.parseReport.anomalies.length > 0 && (
              <>
                <h3 className="font-bold mt-6 text-red-600">Anomalies</h3>
                <ul className="list-disc list-inside">
                  {result.parseReport.anomalies.map((anomaly, i) => (
                    <li key={i} className="text-red-500">
                      {anomaly}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
