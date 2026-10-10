/**
 * The parts of an Assetto Corsa server results file (results/*.json) that the upload, parse and
 * ingest steps read. Fields the server always writes are required; the rest are optional.
 */

export type AcDriver = { Guid?: string; Name?: string; Team?: string; Nation?: string; ClassID?: string };

export type AcCar = {
  CarId?: number;
  Driver?: AcDriver;
  Model: string;
  Skin?: string;
  BallastKG?: number;
  Restrictor?: number;
};

export type AcResultRow = {
  DriverGuid?: string;
  DriverName: string;
  CarId?: number;
  CarModel: string;
  BestLap?: number;
  TotalTime?: number;
  LapCount?: number;
  Disqualified?: boolean;
  Gap?: string;
  PenaltyTime?: number;
  LapPenalty?: number;
};

export type AcLap = {
  DriverGuid?: string;
  CarId?: number;
  LapTime: number;
  Sectors?: number[];
  Cuts?: number;
  Tyre?: string;
  Timestamp?: number;
};

type AcVector = { X?: number; Y?: number; Z?: number };

export type AcEvent = {
  Type: string;
  CarId?: number;
  Driver?: AcDriver;
  OtherCarId?: number;
  OtherDriver?: AcDriver;
  ImpactSpeed: number;
  WorldPosition?: AcVector;
  RelPosition?: AcVector;
};

export type AcResultFile = {
  TrackName?: string;
  TrackConfig?: string;
  Date?: string;
  Cars?: AcCar[];
  Result?: AcResultRow[];
  Laps?: AcLap[];
  Events?: AcEvent[];
};
